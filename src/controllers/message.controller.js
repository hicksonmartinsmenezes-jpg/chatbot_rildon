const { sendMessage, sendTypingPresence } = require("../config/whatsapp");
const { saveHistory } = require("../services/history.service");
const { emitEvent }   = require("../services/socket.service");
const logger          = require("../utils/logger");

async function sendManualMessage(req, res) {
  try {
    const { userId, message } = req.body || {};

    if (!userId || !message) {
      return res.status(400).json({
        error: "userId e message são obrigatórios."
      });
    }

    // CORRIGIDO: garante que message é string
    if (typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "message deve ser uma string não vazia." });
    }

    if (message.length > 4096) {
      return res.status(400).json({ error: "Mensagem muito longa (máx. 4096 caracteres)." });
    }

    const sent = await sendMessage(userId, message.trim());

    const historyItem = await saveHistory({
      userId,
      contactName: "",
      message: null,
      response: message.trim(),
      sector: "manual",
      messageId: sent?.id || null,
      status: "sent"
    });

    emitEvent("nova_mensagem", {
      userId,
      contactName: "",
      message: null,
      response: message.trim(),
      sector: "manual",
      messageId: sent?.id || null,
      status: "sent",
      createdAt: new Date()
    });

    res.json({
      success: true,
      messageId: sent?.id || null,
      remoteJid: sent?.remoteJid || null,
      fromMe: sent?.fromMe ?? true,
      history: historyItem
    });

  } catch (error) {
    // CORRIGIDO: console.error → logger.error
    logger.error(`[sendManualMessage] ${error.message}`);
    res.status(500).json({ error: "Erro ao enviar mensagem." });
  }
}

async function sendTyping(req, res) {
  try {
    const { userId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId obrigatório." });
    }

    emitEvent("typing", { userId, from: "agent" });

    await sendTypingPresence(userId);

    return res.json({ success: true });

  } catch (error) {
    // CORRIGIDO: console.error → logger.error
    logger.error(`[sendTyping] ${error.message}`);
    return res.status(500).json({ error: "Erro ao enviar presença." });
  }
}

module.exports = {
  sendManualMessage,
  sendTyping
};
