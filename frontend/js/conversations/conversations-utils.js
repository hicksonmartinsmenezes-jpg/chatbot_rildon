// conversations-utils.js
// Funções utilitárias puras usadas pela tela de conversas.

// PEDIDO DO USUÁRIO (2026-08-14): "preciso que remova transcrições de
// imagens e stickers como: [imagem recebida] [sticker recebido]". O backend
// grava esse rótulo em `message` pra mídia sem legenda (whatsapp.js) — ele
// nunca foi pensado pra aparecer como TEXTO pro atendente, só como um
// marcador interno pra a linha nunca ficar vazia no histórico (ver
// comentário em 07-conversations.js). Como a mídia real já aparece como
// balão (renderMediaBubble — foto/áudio/vídeo/documento), mostrar esse
// colchete como se fosse uma frase digitada pelo cliente é redundante e
// confuso. Esta função reconhece os 5 rótulos que o backend realmente gera
// (message-utils.js getMediaType: imagem/sticker/áudio/documento/vídeo) e
// devolve um rótulo amigável pra lugares que precisam de um texto curto
// (prévia da lista de conversas, notificação do SO) — ou null quando a
// mensagem é texto de verdade, pra quem só precisa saber "isso é só o
// marcador de mídia, não mostre como frase" (ex: bolha do chat, que já tem
// a mídia visível ao lado).
const _MEDIA_PLACEHOLDER_LABELS = {
  "imagem recebida":    "📷 Foto",
  "sticker recebido":   "🌟 Figurinha",
  "áudio recebido":     "🎤 Áudio",
  "documento recebido": "📎 Documento",
  "vídeo recebido":     "🎬 Vídeo",
};

function mediaPlaceholderFriendlyLabel(msg) {
  if (!msg) return null;
  const m = /^\[(.+)\]$/.exec(msg.trim());
  if (!m) return null;
  return _MEDIA_PLACEHOLDER_LABELS[m[1].toLowerCase()] || null;
}

function isMediaPlaceholderLabel(msg) {
  return mediaPlaceholderFriendlyLabel(msg) !== null;
}

function getLastHistoryItem(userId) {
  // Snapshot para evitar race se allHistory for substituído durante iteração
  const snap = allHistory;
  return snap
    .filter(item => item.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function lastMessage(userId) {
  const last   = getLastHistoryItem(userId);
  const raw    = last?.message || last?.response || "Sem mensagens";
  const text   = mediaPlaceholderFriendlyLabel(last?.message) || raw;
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
