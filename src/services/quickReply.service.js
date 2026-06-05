const quickReplyRepository = require("../repositories/quick-reply.repository");
const logger = require("../utils/logger");

async function getQuickReplies() {
  return quickReplyRepository.findAll();
}

async function saveQuickReplies(replies) {
  return quickReplyRepository.replaceAll(replies);
}

async function findQuickReply(shortcut) {
  return quickReplyRepository.findByShortcut(shortcut);
}

logger.info("⚡ PostgreSQL: respostas rápidas carregadas");

module.exports = {
  getQuickReplies,
  saveQuickReplies,
  findQuickReply
};
