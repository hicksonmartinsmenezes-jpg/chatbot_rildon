const { sendMessage, sendTypingPresence } = require("../config/whatsapp");
const { saveHistory } = require("../services/history.service");
const { emitEvent }   = require("../services/socket.service");
const humanMode       = require("../services/humanMode.service");
const logger          = require("../utils/logger");
const ticketRepository = require("../repositories/ticket.repository");
const { canAccessTicket, isPrivileged, canUseFullConversationPanel } = require("../utils/access-control");

// Autorização de conversa: privilegiados (admin/supervisor/api) sempre podem.
// Atendente só acessa se houver ticket ATIVO atribuído a ele — ou não atribuído
// no mesmo setor (allowUnassigned). Centraliza a regra antes repetida 3×.
async function canUserAccessConversation(user, userId) {
  if (isPrivileged(user) || canUseFullConversationPanel(user)) return true;
  const tickets = await ticketRepository.findByUserId(userId);
  const ativos  = tickets.filter(t => t.status === "aberto" || t.status === "em_andamento");
  return ativos.some(t => canAccessTicket(user, t, { allowUnassigned: true }));
}

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

    // Segurança: atendente só pode enviar mensagem para conversa permitida.
    if (!(await canUserAccessConversation(req.user, userId))) {
      return res.status(403).json({ error: "Você não tem permissão para enviar mensagem para esta conversa." });
    }

    const sent = await sendMessage(userId, message.trim());

    // Atendente enviou mensagem → assume a conversa e pausa o bot para este cliente
    humanMode.ativar(userId, { agentName: req.user?.nome || req.user?.usuario || "" });

    // Busca nome do contato no histórico para não deixar em branco
    let contactName = "";
    try {
      const pool = require("../database/postgres");
      const r = await pool.query(
        `SELECT contact_name FROM history WHERE user_id = $1 AND contact_name IS NOT NULL AND contact_name <> '' ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      contactName = r.rows[0]?.contact_name || "";
    } catch (_) {}

    // Salva histórico separado do envio — falha aqui não afeta a resposta ao frontend
    let historyItem = null;
    try {
      historyItem = await saveHistory({
        userId,
        contactName,
        message: null,
        response: message.trim(),
        sector: "manual",
        messageId: sent?.id || null,
        status: "sent"
      });

      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message: null,
        response: message.trim(),
        sector: "manual",
        messageId: sent?.id || null,
        status: "sent",
        createdAt: new Date()
      });
    } catch (histErr) {
      logger.warn(`[sendManualMessage] Histórico não salvo: ${histErr.message}`);
    }

    res.json({
      success: true,
      messageId: sent?.id || null,
      remoteJid: sent?.remoteJid || null,
      fromMe: sent?.fromMe ?? true,
      history: historyItem
    });

  } catch (error) {
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

    if (!(await canUserAccessConversation(req.user, userId))) {
      return res.status(403).json({ error: "Você não tem permissão para sinalizar digitação nesta conversa." });
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

// Lista os clientes atualmente em atendimento humano (bot pausado)
function listHumanMode(req, res) {
  res.json({ users: humanMode.listar() });
}

// "Devolver ao bot" — reativa o bot para um cliente
async function releaseHumanMode(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId obrigatório." });

  if (!(await canUserAccessConversation(req.user, userId))) {
    return res.status(403).json({ error: "Você não tem permissão para devolver esta conversa ao bot." });
  }

  humanMode.desativar(userId, "painel");
  return res.json({ ok: true });
}

module.exports = {
  sendManualMessage,
  sendTyping,
  listHumanMode,
  releaseHumanMode
};
