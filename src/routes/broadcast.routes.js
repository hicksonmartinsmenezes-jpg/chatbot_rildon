const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { auditLog } = require("../services/audit.service");
const { emitEvent } = require("../services/socket.service");
const { uploadLimiter, criticalActionLimiter } = require("../middlewares/rate-limiters");

const {
  createBroadcast,
  listBroadcasts,
  getBroadcastRecipients,
  startBroadcast,
  cancelBroadcast,
  deleteBroadcast,
  retryFailedRecipients,
  getBroadcastAudience,
  getBroadcastStats
} = require("../services/broadcast.service");

const router = express.Router();

router.get("/broadcasts", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20")));
    const broadcasts = await listBroadcasts({ page, limit });
    res.json(broadcasts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const uploadDir = path.join(__dirname, "../uploads/campaigns");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const baseName = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-. ]/g, "")   // remove caracteres perigosos
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 80) || "arquivo";
    cb(null, `${baseName}-${Date.now()}${ext}`);
  }
});

const ALLOWED_MEDIA = {
  image: new Map([
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".png", "image/png"],
    [".gif", "image/gif"],
    [".webp", "image/webp"]
  ]),
  pdf: new Map([[".pdf", "application/pdf"]]),
  audio: new Map([
    [".mp3", "audio/mpeg"],
    [".ogg", "audio/ogg"],
    [".m4a", "audio/mp4"],
    [".wav", "audio/wav"],
    [".aac", "audio/aac"],
    [".opus", "audio/ogg"]
  ])
};

function mimetypeMatches(expected, received) {
  if (!expected || !received) return false;
  if (expected === received) return true;
  // Alguns navegadores/sistemas enviam WAV como x-wav.
  if (expected === "audio/wav" && received === "audio/x-wav") return true;
  // Alguns clientes enviam M4A como x-m4a.
  if (expected === "audio/mp4" && received === "audio/x-m4a") return true;
  return false;
}

function detectMediaType(file) {
  const ext = path.extname(file.originalname || file.filename || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();

  for (const [type, map] of Object.entries(ALLOWED_MEDIA)) {
    const expected = map.get(ext);
    if (mimetypeMatches(expected, mime)) return type;
  }

  return null;
}

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — PDFs e áudios podem ser grandes
  fileFilter: (req, file, cb) => {
    const type = detectMediaType(file);
    if (!type) return cb(new Error("Tipo de arquivo não permitido. Use imagem, PDF ou áudio."));
    cb(null, true);
  }
});


router.post("/broadcasts", criticalActionLimiter, async (req, res) => {
  try {
    const { title, message, recipients, imageUrl, mediaType } = req.body;

    const broadcast = await createBroadcast({
      title,
      message,
      recipients,
      imageUrl,
      mediaType: mediaType || (imageUrl ? "image" : null),
      createdBy: req.user?.nome || req.user?.usuario || null
    });

    await auditLog({ user: req.user, action: "BROADCAST_CREATE", target: `broadcast:${broadcast.id || broadcast.broadcastId || "novo"}`, details: { title, recipients: Array.isArray(recipients) ? recipients.length : undefined } });
    emitEvent("broadcasts_updated", { action: "created", broadcast, by: req.user?.id || req.user?.usuario || null });
    res.status(201).json(broadcast);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


router.post("/broadcasts/upload", uploadLimiter, (req, res) => {
  upload.single("media")(req, res, async (err) => {
    if (err) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? "Arquivo muito grande. Máximo permitido: 100 MB."
        : err.message || "Erro ao processar arquivo.";
      return res.status(400).json({ error: msg });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: "Nenhum arquivo enviado." });
      }

      const mediaType = detectMediaType(req.file);
      if (!mediaType) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Tipo de arquivo não permitido." });
      }

      await auditLog({ user: req.user, action: "BROADCAST_UPLOAD", target: "broadcast-media", details: { filename: req.file.filename, mediaType, size: req.file.size } });
      emitEvent("broadcasts_updated", { action: "media_uploaded", filename: req.file.filename, mediaType, by: req.user?.id || req.user?.usuario || null });
      res.json({ url: `/uploads/campaigns/${req.file.filename}`, mediaType });
    } catch (e) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      res.status(500).json({ error: e.message });
    }
  });
});

router.get("/broadcasts/audience/:type", async (req, res) => {
  try {
    const { tag, atendenteId } = req.query;
    // `tags` pode chegar como string única (?tags=a), array (?tags=a&tags=b,
    // já parseado pelo Express) ou string separada por vírgula (?tags=a,b) —
    // normaliza pros três formatos.
    let tags = req.query.tags;
    if (typeof tags === "string") tags = tags.split(",").map(t => t.trim()).filter(Boolean);
    if (!Array.isArray(tags)) tags = [];

    const audience = await getBroadcastAudience(req.params.type, { tag, tags, atendenteId });
    res.json(audience);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


router.get("/broadcasts/stats", async (req, res) => {
  try {
    const stats = await getBroadcastStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.get("/broadcasts/:id/recipients", async (req, res) => {
  try {
    const recipients = await getBroadcastRecipients(req.params.id);
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/broadcasts/:id/start", criticalActionLimiter, async (req, res) => {
  try {
    const result = await startBroadcast(req.params.id);
    await auditLog({ user: req.user, action: "BROADCAST_START", target: `broadcast:${req.params.id}`, details: result });
    emitEvent("broadcasts_updated", { action: "started", id: req.params.id, result, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/broadcasts/:id/cancel", criticalActionLimiter, async (req, res) => {
  try {
    const result = await cancelBroadcast(req.params.id);
    await auditLog({ user: req.user, action: "BROADCAST_CANCEL", target: `broadcast:${req.params.id}`, details: result });
    emitEvent("broadcasts_updated", { action: "cancelled", id: req.params.id, result, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/broadcasts/:id/retry", criticalActionLimiter, async (req, res) => {
  try {
    const result = await retryFailedRecipients(req.params.id);
    await auditLog({ user: req.user, action: "BROADCAST_RETRY", target: `broadcast:${req.params.id}`, details: result });
    emitEvent("broadcasts_updated", { action: "retried", id: req.params.id, result, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/broadcasts/:id", criticalActionLimiter, async (req, res) => {
  try {
    const result = await deleteBroadcast(req.params.id);
    await auditLog({ user: req.user, action: "BROADCAST_DELETE", target: `broadcast:${req.params.id}`, details: result });
    emitEvent("broadcasts_updated", { action: "deleted", id: req.params.id, result, by: req.user?.id || req.user?.usuario || null });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;