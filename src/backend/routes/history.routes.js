const express = require("express");
const router = express.Router();
const { getHistoryHandler, getConversationsHandler } = require("../controllers/history.controller");

// Retorna a última mensagem por usuário distinto (para o painel de conversas)
router.get("/history/conversations", getConversationsHandler);
router.get("/history", getHistoryHandler);

module.exports = router;
