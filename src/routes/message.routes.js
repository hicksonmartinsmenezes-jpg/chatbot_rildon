const express = require("express");

const {
    sendManualMessage,
    sendTyping,
    listHumanMode,
    releaseHumanMode
} = require("../controllers/message.controller");

const { forceReconnect, getConnectionInfo } = require("../config/whatsapp");
const { requirePrivileged } = require("../utils/access-control");
const { auditLog } = require("../services/audit.service");
const { messageLimiter, criticalActionLimiter } = require("../middlewares/rate-limiters");

const router = express.Router();

router.post("/messages/send", messageLimiter, sendManualMessage);

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