const express = require("express");
const axios   = require("axios");
const multer  = require("multer");
const { getProfilePhotoUrl } = require("../config/whatsapp");
const logger = require("../utils/logger");
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
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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
      return res.set("Cache-Control", "no-store").status(404).end();
    }

    // Proxia a imagem pelo backend para evitar CORS e URLs expiradas no browser
    const response = await axios.get(photoUrl, {
      responseType: "arraybuffer",
      timeout: 8000
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "private, max-age=300"); // cache 5 min só no browser do usuário
    return res.send(Buffer.from(response.data));

  } catch (error) {
    logger.error(`Erro ao buscar foto: ${error.message}`);
    return res.set("Cache-Control", "no-store").status(404).end();
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

router.get("/contacts/export", async (req, res) => {
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
    res.send(header + rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/contacts/import", csvUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Arquivo CSV não enviado." });
    const content = req.file.buffer.toString("utf-8");
    const rows = parseCSV(content);
    const result = await importContacts(rows);
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

router.post("/contacts", async (req, res) => {
  try {
    const contact = await createContact(req.body);
    res.status(201).json(contact);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/contacts/:id", async (req, res) => {
  try {
    res.json(await updateContact(req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/contacts/bulk", async (req, res) => {
  try {
    const { ids } = req.body;
    res.json(await deleteContacts(ids));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/contacts/:id", async (req, res) => {
  try {
    res.json(await deleteContact(req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

module.exports = router;
