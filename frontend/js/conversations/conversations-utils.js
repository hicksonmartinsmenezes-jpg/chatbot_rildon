// conversations-utils.js
// Funções utilitárias puras usadas pela tela de conversas.

function getLastHistoryItem(userId) {
  // Snapshot para evitar race se allHistory for substituído durante iteração
  const snap = allHistory;
  return snap
    .filter(item => item.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function lastMessage(userId) {
  const last   = getLastHistoryItem(userId);
  const text   = last?.message || last?.response || "Sem mensagens";
  const prefix = last?.response && !last?.message ? "Você: " : "";
  return cutText(`${prefix}${text}`, 52);
}

// ─── Abre conversa com header de ações de ticket ──────────────────────────────
let _openConvSeq = 0;
let _openConvAbort = null;

function renderMessageStatus(status) {
  switch (status) {
    case "read":      return `<i class="fa-solid fa-check-double" style="color:#53bdeb"></i>`;
    case "delivered": return `<i class="fa-solid fa-check-double"></i>`;
    case "sent":      return `<i class="fa-solid fa-check"></i>`;
    default:          return `<i class="fa-solid fa-check"></i>`;
  }
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
let lastTypingAt = 0;

function _notifTimeAgo(date) {
  const diff = Math.floor((Date.now() - date) / 1000);
  if (diff < 60)  return "agora";
  if (diff < 3600) return `${Math.floor(diff/60)}min atrás`;
  return `${Math.floor(diff/3600)}h atrás`;
}
