const express = require("express");
const path    = require("path");
const fs      = require("fs");
const multer  = require("multer");

const {
    sendManualMessage,
    sendMediaMessage,
    sendTyping,
    listHumanMode,
    releaseHumanMode
} = require("../controllers/message.controller");

const { forceReconnect, getConnectionInfo } = require("../config/whatsapp");
const { requirePrivileged } = require("../utils/access-control");
const { auditLog } = require("../services/audit.service");
const { messageLimiter, criticalActionLimiter, uploadLimiter } = require("../middlewares/rate-limiters");
const { MEDIA_DIR } = require("../services/mediaStorage.service");

const router = express.Router();

router.post("/messages/send", messageLimiter, sendManualMessage);

// ── Envio de arquivo (foto/vídeo/documento) pelo painel, igual WhatsApp ─────
// Pedido do usuário (2026-07-23). Salva DIRETO em MEDIA_DIR (mesma pasta de
// mediaStorage.service.js usada pra mídia RECEBIDA do cliente) — assim a
// rota já existente GET /api/history/media/:id serve de volta sem precisar
// de nada novo pra isso. Diferente de broadcasts (só imagem/pdf/áudio, uso
// em massa), aqui aceita também vídeo e QUALQUER documento (o WhatsApp de
// verdade não restringe tipo de documento anexado por um usuário comum).
const messageMediaStorage = multer.diskStorage({
  destination: MEDIA_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 10) || "";
    const sufixo = require("crypto").randomBytes(6).toString("hex");
    cb(null, `enviada-${Date.now()}-${sufixo}${ext}`);
  }
});

// Tipos ACEITOS: imagem e vídeo por mimetype (whitelist — controla como o
// Baileys/WhatsApp trata o anexo); documento é o fallback pra QUALQUER outro
// tipo, igual o comportamento real do WhatsApp ao anexar um "Documento".
const IMAGE_MIMETYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_MIMETYPES = new Set(["video/mp4", "video/3gpp", "video/quicktime"]);

function detectMessageMediaType(mimetype = "") {
  const mime = String(mimetype).toLowerCase();
  if (IMAGE_MIMETYPES.has(mime)) return "image";
  if (VIDEO_MIMETYPES.has(mime)) return "video";
  return "document"; // fallback genérico — qualquer outro tipo de arquivo
}

const uploadMessageMedia = multer({
  storage: messageMediaStorage,
  // WhatsApp real limita ~16MB pra imagem/vídeo e até 100MB pra documento —
  // usamos um teto único generoso (64MB) simples de explicar/ajustar.
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

// Atendimento humano (bot pausado)
router.get("/messages/humanmode", listHumanMode);
router.post("/messages/humanmode/release", criticalActionLimiter, releaseHumanMode);

// Status atual da conexão WhatsApp + QR pendente (para o painel renderizar
// um QR mesmo que o evento socket efêmero "qr_code" já tenha passado).
router.get("/whatsapp/status", (req, res) => {
  res.json(getConnectionInfo());
});

// Reconexão WhatsApp. body { clearSession: true } força re-pareamento (apaga
// auth_info e gera QR novo); sem isso faz reconexão usando a sessão existente.
router.post("/whatsapp/reconnect", requirePrivileged, criticalActionLimiter, async (req, res) => {
  try {
    const clearSession = req.body?.clearSession === true;
    await forceReconnect({ clearSession });
    await auditLog({
      user: req.user,
      action: clearSession ? "WHATSAPP_REPAIR" : "WHATSAPP_RECONNECT",
      target: "whatsapp",
      details: { clearSession, ip: req.ip || req.socket?.remoteAddress || "unknown" }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;