const quickReplyRepository =
  require("../repositories/quick-reply.repository");

async function getQuickReplies() {
  return quickReplyRepository.findAll();
}

async function saveQuickReplies(replies) {
  return quickReplyRepository.replaceAll(replies);
}

async function findQuickReply(shortcut) {
  return quickReplyRepository.findByShortcut(shortcut);
}

console.log(
  "⚡ PostgreSQL: respostas rápidas carregadas"
);

module.exports = {
  getQuickReplies,
  saveQuickReplies,
  findQuickReply
};