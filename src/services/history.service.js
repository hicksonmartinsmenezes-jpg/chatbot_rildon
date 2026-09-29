const historyRepository = require("../repositories/history.repository");
const logger = require("../utils/logger");

async function saveHistory({
  userId,
  contactName,
  message,
  response,
  sector,
  messageId,
  status,
  mediaPath,
  mediaMimetype,
  mediaFilename,
  quotedMessageId,
  quotedText
}) {
  return historyRepository.create({
    userId,
    contactName: contactName || "",
    message: message || null,
    response: response || null,
    sector: sector || "geral",
    messageId: messageId || null,
    // CORRIGIDO: status vazio → null (alinhado ao schema corrigido)
    status: status || null,
    // Ver migration 017 — arquivo de mídia recebida do cliente (foto/áudio/
    // vídeo/sticker/documento), salvo em src/media-recebida/.
    mediaPath: mediaPath || null,
    mediaMimetype: mediaMimetype || null,
    mediaFilename: mediaFilename || null,
    // Ver migration 019 — "responder mensagem específica" (reply/quote).
    quotedMessageId: quotedMessageId || null,
    quotedText: quotedText || null,
    createdAt: new Date()
  });
}

async function listHistory({ userId, limit, offset, q, from, to, horaInicio, horaFim } = {}) {
  return historyRepository.findAll({
    userId,
    limit: limit || 50,
    offset: offset || 0,
    q,
    from,
    to,
    horaInicio,
    horaFim
  });
}

async function listHistoryGrouped({ q, from, to, horaInicio, horaFim, limit, offset } = {}) {
  return historyRepository.findGroupedByUser({
    q, from, to, horaInicio, horaFim,
    limit: limit || 500,
    offset: offset || 0
  });
}

// Ver comentário em history.repository.js (getGroupedSummary) — usado pelo
// painel de Histórico pra paginar de verdade (pedido do usuário,
// 2026-09-23) mantendo os 4 cards de resumo corretos mesmo mostrando só
// uma página de clientes.
async function getHistoryGroupedSummary({ q, from, to, horaInicio, horaFim } = {}) {
  return historyRepository.getGroupedSummary({ q, from, to, horaInicio, horaFim });
}

async function listHistoryByUser(userId) {
  return historyRepository.findAll({ userId, limit: 500 });
}

async function getHistoryById(id) {
  return historyRepository.findById(id);
}

async function updateMessageStatus(messageId, status) {
  return historyRepository.updateMessageStatus(messageId, status);
}

logger.info("💬 PostgreSQL: histórico carregado");

module.exports = {
  saveHistory,
  listHistory,
  listHistoryGrouped,
  getHistoryGroupedSummary,
  listHistoryByUser,
  getHistoryById,
  updateMessageStatus
};
