const express = require("express");

const {
    sendManualMessage,
    sendTyping,
    listHumanMode,
    releaseHumanMode
} = require("../controllers/message.controller");

const { forceReconnect } = require("../config/whatsapp");
const { requirePrivileged } = require("../utils/access-control");
const { auditLog } = require("../services/audit.service");
const { messageLimiter, criticalActionLimiter } = require("../middlewares/rate-limiters");

const router = express.Router();

router.post("/messages/send", messageLimiter, sendManualMessage);

router.post("/messages/typing", messageLimiter, sendTyping);

// Atendimento humano (bot pausado)
router.get("/messages/humanmode", listHumanMode);
router.post("/messages/humanmode/release", criticalActionLimiter, releaseHumanMode);

// Reconexão WhatsApp
router.post("/whatsapp/reconnect", requirePrivileged, criticalActionLimiter, async (req, res) => {
  try {
    await forceReconnect();
    await auditLog({
      user: req.user,
      action: "WHATSAPP_RECONNECT",
      target: "whatsapp",
      details: { ip: req.ip || req.socket?.remoteAddress || "unknown" }
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;