const express = require("express");

const {
    sendManualMessage,
    sendTyping,
    listHumanMode,
    releaseHumanMode
} = require("../controllers/message.controller");

const router = express.Router();

router.post("/messages/send", sendManualMessage);

router.post("/messages/typing", sendTyping);

// Atendimento humano (bot pausado)
router.get("/messages/humanmode", listHumanMode);
router.post("/messages/humanmode/release", releaseHumanMode);

module.exports = router;