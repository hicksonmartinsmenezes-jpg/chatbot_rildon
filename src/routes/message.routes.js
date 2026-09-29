const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const QRCode = require("qrcode");

const { sendManualMessage, sendMediaMessage, sendTyping, listHumanMode, releaseHumanMode } = require("../controllers/message.controller");
const { forceReconnect, getConnectionInfo } = require("../config/whatsapp");
const { requirePrivileged } = require("../utils/access-control");
const { auditLog } = require("../services/audit.service");
const { messageLimiter, criticalActionLimiter, uploadLimiter } = require("../middlewares/rate-limiters");
const { MEDIA_DIR } = require("../services/mediaStorage.service");

const router = express.Router();

router.post("/messages/send", messageLimiter, sendManualMessage);

const messageMediaStorage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 10) || "";
    const sufixo = require("crypto").randomBytes(6).toString("hex");
    cb(null, `enviada-${Date.now()}-${sufixo}${ext}`);
  }
});

const IMAGE_MIMETYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_MIMETYPES = new Set(["video/mp4", "video/3gpp", "video/quicktime"]);
function detectMessageMediaType(mimetype = "") {
  const mime = String(mimetype).toLowerCase();
  if (IMAGE_MIMETYPES.has(mime)) return "image";
  if (VIDEO_MIMETYPES.has(mime)) return "video";
  return "document";
}
const uploadMessageMedia = multer({
  storage: messageMediaStorage,
  limits: { fileSize: Number(process.env.MESSAGE_MEDIA_MAX_MB || 64) * 1024 * 1024 },
});

router.post("/messages/send-media", uploadLimiter, (req, res) => {
  uploadMessageMedia.single("media")(req, res, (err) => {
    if (err) {
      if (req.file?.path) fs.unlink(req.file.path, () => {});
      const msg = err.code === "LIMIT_FILE_SIZE"
        ? `Arquivo muito grande. Máximo permitido: ${Number(process.env.MESSAGE_MEDIA_MAX_MB || 64)} MB.`
        : err.message || "Erro ao processar arquivo.";
      return res.status(400).json({ error: msg });
    }
    req.mediaType = req.file ? detectMessageMediaType(req.file.mimetype) : null;
    sendMediaMessage(req, res);
  });
});

router.post("/messages/typing", messageLimiter, sendTyping);
router.get("/messages/humanmode", listHumanMode);
router.post("/messages/humanmode/release", criticalActionLimiter, releaseHumanMode);

// Status + QR como imagem gerada no backend. Isso elimina a dependência do CDN
// da biblioteca QRCode no navegador para o pareamento funcionar.
router.get("/whatsapp/status", async (req, res) => {
  try {
    const info = getConnectionInfo();
    if (!info.qr) return res.json(info);
    const qrImage = await QRCode.toDataURL(info.qr, { width: 260, margin: 2, errorCorrectionLevel: "M" });
    return res.json({ ...info, qrImage });
  } catch (err) {
    return res.status(500).json({ error: "Não foi possível preparar o QR Code.", detail: err.message });
  }
});

router.post("/whatsapp/reconnect", requirePrivileged, criticalActionLimiter, async (req, res) => {
  try {
    const clearSession = req.body?.clearSession === true;
    await forceReconnect({ clearSession });
    await auditLog({ user: req.user, action: clearSession ? "WHATSAPP_REPAIR" : "WHATSAPP_RECONNECT", target: "whatsapp", details: { clearSession, ip: req.ip || req.socket?.remoteAddress || "unknown" } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
