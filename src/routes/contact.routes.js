const express = require("express");
const axios   = require("axios");
const multer  = require("multer");
const { getProfilePhotoUrl } = require("../config/whatsapp");
const logger = require("../utils/logger");
const { requirePrivileged } = require("../utils/access-control");
const { auditLog } = require("../services/audit.service");
const { emitEvent } = require("../services/socket.service");
const { uploadLimiter, criticalActionLimiter } = require("../middlewares/rate-limiters");
const {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  deleteContacts,
  importContacts,
  getAllTags
} = require("../services/contacts.service");

const router = express.Router();
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const original = String(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    const allowed = original.endsWith(".csv") && ["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain"].includes(mime);
    if (!allowed) return cb(new Error("Envie apenas arquivo CSV válido."));
    return cb(null, true);
  }
});

// Previne CSV formula injection (= + - @ no início → prefixo com apóstrofo ao exportar)
function sanitizeCsvCell(val) {
  if (typeof val !== "string") return val;
  return /^[=+\-@\t\r]/.test(val) ? `'${val}` : val;
}

function parseCSV(content) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, "").trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || [];
    const obj = {};
    headers.forEach((h, i) => {
      const raw = (vals[i] || "").trim().replace(/^"|"$/g, "");
      obj[h] = sanitizeCsvCell(raw);
    });
    return obj;
  }).filter(r => Object.values(r).some(v => v));
}

// Rate limit por userId (30/min) e por IP global (200/min)
const _photoRateUser = new Map();
const _photoRateIp   = new Map();
setInterval(() => { _photoRateUser.clear(); _photoRateIp.clear(); }, 60_000);

function photoRateOk(userId, ip) {
  const userCount = (_photoRateUser.get(userId) || 0) + 1;
  _photoRateUser.set(userId, userCount);
  if (userCount > 30) return false;

  const ipCount = (_photoRateIp.get(ip) || 0) + 1;
  _photoRateIp.set(ip, ipCount);
  if (ipCount > 200) return false;

  return true;
}

router.get("/contacts/photo", async (req, res) => {
  const requestedAt = Date.now();
  try {
    const { userId } = req.query;

    if (!userId || typeof userId !== "string" || userId.length > 200) {
      return res.status(400).json({ error: "userId inválido." });
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (!photoRateOk(userId, ip)) {
      return res.set("Cache-Control", "no-store").status(429).end();
    }

    const photoUrl = await getProfilePhotoUrl(userId);

    if (!photoUrl) {
      // 204 é intencional: o frontend mantém as iniciais e não mostra imagem quebrada.
      logger.debug?.(`[FotoContato] indisponível userId=${userId} em ${Date.now() - requestedAt}ms`);
      return res.set("Cache-Control", "no-store").status(204).end();
    }

    // Proxia a imagem pelo backend para evitar CORS e URLs expiradas no browser.
    // Alguns endpoints temporários do WhatsApp rejeitam requisições sem User-Agent.
    const response = await axios.get(photoUrl, {
      responseType: "arraybuffer",
      timeout: 10000,
      maxRedirects: 3,
      validateStatus: status => status >= 200 && status < 300,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    const buffer = Buffer.from(response.data || []);
    const contentType = String(response.headers["content-type"] || "image/jpeg").toLowerCase();

    if (!buffer.length || !contentType.startsWith("image/")) {
      logger.debug?.(`[FotoContato] resposta inválida userId=${userId} type=${contentType} bytes=${buffer.length}`);
      return res.set("Cache-Control", "no-store").status(204).end();
    }

    // Evita SVG como imagem de avatar. WhatsApp costuma entregar jpeg/webp.
    if (contentType.includes("svg")) {
      return res.set("Cache-Control", "no-store").status(204).end();
    }

    res.set("Content-Type", contentType);
    res.set("Content-Length", String(buffer.length));
    res.set("Cache-Control", "private, max-age=300");
    return res.send(buffer);

  } catch (error) {
    logger.warn(`Foto indisponível para contato: ${error.message}`);
    return res.set("Cache-Control", "no-store").status(204).end();
  }
});

// ── CRUD Contatos ─────────────────────────────────────────────────────────────

router.get("/contacts", async (req, res) => {
  try {
    const { page, limit, search, status, tag, atendenteId } = req.query;
    const result = await listContacts({
      page: parseInt(page || "1"),
      limit: Math.min(100, parseInt(limit || "40")),
      search: search || "",
      status: status || "",
      tag: tag || "",
      atendenteId: atendenteId || ""
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/contacts/tags", async (req, res) => {
  try {
    res.json(await getAllTags());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/contacts/export", requirePrivileged, criticalActionLimiter, async (req, res) => {
  try {
    const result = await listContacts({ limit: 10000 });
    const header = "nome,whatsapp,estado,status,tags,departamento,atendente\n";
    const rows = result.rows.map(r =>
      [r.nome, r.whatsapp, r.estado || "", r.status,
       (r.tags || []).join(";"), r.departamento || "", r.atendente_nome || ""]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    ).join("\n");
    res.set("Content-Type", "text/csv");
    res.set("Content-Disposition", `attachment; filename="contatos.csv"`);
    await auditLog({ user: req.user, action: "CONTACTS_EXPORT", target: "contacts", details: { total: result.rows.length } });
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/contacts/import", requirePrivileged, uploadLimiter, csvUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo CSV não enviado." });
    const content = req.file.buffer.toString("utf-8");
    const rows = parseCSV(content);
    const result = await importContacts(rows);
    await auditLog({ user: req.user, action: "CONTACTS_IMPORT", target: "contacts", details: result });
    emitEvent("contacts_updated", { action: "imported", result, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/contacts/:id", async (req, res) => {
  try {
    res.json(await getContact(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/contacts", requirePrivileged, async (req, res) => {
  try {
    const contact = await createContact(req.body);
    await auditLog({ user: req.user, action: "CONTACT_CREATE", target: `contact:${contact.id}`, details: { whatsapp: contact.whatsapp } });
    emitEvent("contacts_updated", { action: "created", contact, by: req.user?.id || req.user?.usuario || null });
    res.status(201).json(contact);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/contacts/:id", requirePrivileged, async (req, res) => {
  try {
    const contact = await updateContact(req.params.id, req.body);
    await auditLog({ user: req.user, action: "CONTACT_UPDATE", target: `contact:${req.params.id}`, details: { fields: Object.keys(req.body || {}) } });
    emitEvent("contacts_updated", { action: "updated", id: req.params.id, contact, by: req.user?.id || req.user?.usuario || null });
    res.json(contact);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/contacts/bulk", requirePrivileged, criticalActionLimiter, async (req, res) => {
  try {
    const { ids } = req.body;
    const result = await deleteContacts(ids);
    await auditLog({ user: req.user, action: "CONTACT_BULK_DELETE", target: "contacts", details: { requested: Array.isArray(ids) ? ids.length : 0, deleted: result.deleted } });
    emitEvent("contacts_updated", { action: "bulk_deleted", ids: Array.isArray(ids) ? ids : [], result, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/contacts/:id", requirePrivileged, criticalActionLimiter, async (req, res) => {
  try {
    const result = await deleteContact(req.params.id);
    await auditLog({ user: req.user, action: "CONTACT_DELETE", target: `contact:${req.params.id}`, details: {} });
    emitEvent("contacts_updated", { action: "deleted", id: req.params.id, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
