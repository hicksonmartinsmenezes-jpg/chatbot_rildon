const historyRepository = require("../repositories/history.repository");
const logger = require("../utils/logger");

async function saveHistory({
  userId,
  contactName,
  message,
  response,
  sector,
  messageId,
  status
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
    createdAt: new Date()
  });
}

async function listHistory({ userId, limit, offset, q, from, to } = {}) {
  return historyRepository.findAll({
    userId,
    limit: limit || 50,
    offset: offset || 0,
    q,
    from,
    to
  });
}

async function listHistoryGrouped({ q, from, to, limit, offset } = {}) {
  return historyRepository.findGroupedByUser({
    q, from, to,
    limit: limit || 500,
    offset: offset || 0
  });
}

async function listHistoryByUser(userId) {
  return historyRepository.findAll({ userId, limit: 500 });
}

async function updateMessageStatus(messageId, status) {
  return historyRepository.updateMessageStatus(messageId, status);
}

logger.info("💬 PostgreSQL: histórico carregado");

module.exports = {
  saveHistory,
  listHistory,
  listHistoryGrouped,
  listHistoryByUser,
  updateMessageStatus
};
