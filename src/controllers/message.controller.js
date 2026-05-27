const { sendMessage, sendTypingPresence } = require("../config/whatsapp");
const { saveHistory } = require("../services/history.service");
const { emitEvent } = require("../services/socket.service");


async function sendManualMessage(req, res) {
  try {
    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({
        error: "userId e message são obrigatórios."
      });
    }

    const sent = await sendMessage(userId, message);

    const historyItem = await saveHistory({
      userId,
      contactName: "",
      message: null,
      response: message,
      sector: "manual",
      messageId: sent.id,
      status: "sent"
    });

    emitEvent("nova_mensagem", {
      userId,
      contactName: "",
      message: null,
      response: message,
      sector: "manual",
      messageId: sent.id,
      status: "sent",
      createdAt: new Date()
    });

    res.json({
      success: true,
      messageId: sent.id,
      remoteJid: sent.remoteJid,
      fromMe: sent.fromMe,
      history: historyItem
    });

  } catch (error) {
    console.error("Erro ao enviar mensagem:", error);

    res.status(500).json({
      error: "Erro ao enviar mensagem."
    });
  }
}

async function sendTyping(req, res) {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: "userId obrigatório."
      });
    }

    emitEvent("typing", {
      userId,
      from: "agent"
    });

    await sendTypingPresence(userId);

    return res.json({
      success: true
    });

  } catch (error) {
    console.error("Erro typing:", error);

    return res.status(500).json({
      error: "Erro ao enviar presença."
    });
  }
}

module.exports = {
  sendManualMessage,
  sendTyping
};