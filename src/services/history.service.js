const historyRepository =
  require("../repositories/history.repository");

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
    message: message || "",
    response: response || "",
    sector: sector || "main",
    messageId: messageId || null,
    status: status || "",
    createdAt: new Date()
  });
}

async function listHistory({
  userId,
  limit,
  offset
} = {}) {
  return historyRepository.findAll({
    userId,
    limit: limit || 50,
    offset: offset || 0
  });
}

async function listHistoryByUser(userId) {
  return historyRepository.findAll({
    userId,
    limit: 500
  });
}

async function updateMessageStatus(messageId, status) {
  return historyRepository.updateMessageStatus(
    messageId,
    status
  );
}

console.log(
  "💬 PostgreSQL: histórico carregado"
);

module.exports = {
  saveHistory,
  listHistory,
  listHistoryByUser,
  updateMessageStatus
};