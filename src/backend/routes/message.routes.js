const express = require("express");

const {
    sendManualMessage,
    sendTyping,
    listHumanMode,
    releaseHumanMode
} = require("../controllers/message.controller");

const { forceReconnect } = require("../config/whatsapp");

const router = express.Router();

router.post("/messages/send", sendManualMessage);

router.post("/messages/typing", sendTyping);

// Atendimento humano (bot pausado)
router.get("/messages/humanmode", listHumanMode);
router.post("/messages/humanmode/release", releaseHumanMode);

// Reconexão WhatsApp
router.post("/whatsapp/reconnect", async (req, res) => {
  try {
    await forceReconnect();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;