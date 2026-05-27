const express = require("express");
const { sendTypingPresence } = require("../config/whatsapp");
const { emitEvent } = require("../services/socket.service");

const {
    sendManualMessage,
    sendTyping
} = require("../controllers/message.controller");

const router = express.Router();

router.post("/messages/send", sendManualMessage);

router.post("/messages/typing", sendTyping);

module.exports = router;