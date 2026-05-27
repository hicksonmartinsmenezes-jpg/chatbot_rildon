// 01-utils.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Status Visual ────────────────────────────────────────────────────────────
function setOnline() {
  const badge = document.getElementById("status-badge");
  if (badge) { badge.textContent = "● Online"; badge.className = "badge badge-ok"; }
}
function setOffline() {
  const badge = document.getElementById("status-badge");
  if (badge) { badge.textContent = "● Offline"; badge.className = "badge badge-off"; }
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function avatarHtml(userId, name, big = false) {
  return `
    <span class="chat-avatar ${big ? "big" : ""}">
      <img src="${BASE}/api/contacts/photo?userId=${encodeURIComponent(userId)}"
        onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';">
      <span class="avatar-fallback">${safe(initials(name))}</span>
    </span>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

function getContactName(userId) {
  return allHistory.find(h => h.userId === userId && h.contactName)?.contactName || "";
}

function contactLabel(userId) {
  const name  = getContactName(userId);
  const phone = formatPhone(userId);
  return name ? `${name} — ${phone}` : phone;
}

function formatPhone(userId) {
  if (!userId) return "—";
  return String(userId)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace("@lid", "");
}

const STATUS_LABELS = { aberto: "Aberto", em_andamento: "Em andamento", resolvido: "Resolvido", cancelado: "Cancelado" };
function statusLabel(status) { return STATUS_LABELS[status] || status || "—"; }

const TIPO_LABELS = {
  suporte_tecnico:      "Suporte Técnico",
  suporte_humano:       "Suporte Humano",
  orcamento:            "Orçamento",
  consultor_vendas:     "Consultor Vendas",
  duvida_financeira:    "Dúvida Financeira",
  atendente_financeiro: "Financeiro Humano",
  atendente_humano:     "Atendente"
};
function tipoLabel(type) { return TIPO_LABELS[type] || type || "Atendimento"; }

function refreshCurrentChatFeed() {
  if (!selectedConversationUser) return;
  openConversation(selectedConversationUser, true);
  const list = document.getElementById("chat-list");
  if (!list) return;
  const activeItem = list.querySelector(`.chat-item[data-user="${cssEscape(selectedConversationUser)}"]`);
  if (!activeItem) return;
  const preview = activeItem.querySelector(".chat-item-bottom span");
  const time    = activeItem.querySelector(".chat-item-top small");
  const last    = getLastHistoryItem(selectedConversationUser);
  if (preview) preview.textContent = lastMessage(selectedConversationUser);
  if (time)    time.textContent    = shortTime(last?.createdAt);
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("pt-BR");
}

function shortTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(value) {
  if (!value) return "Hoje";
  const date      = new Date(value);
  if (Number.isNaN(date.getTime())) return "Hoje";
  const today     = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (sameDate(date, today))     return "Hoje";
  if (sameDate(date, yesterday)) return "Ontem";
  return date.toLocaleDateString("pt-BR");
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth()   === b.getMonth()   &&
    a.getDate()    === b.getDate();
}

function initials(value) {
  const clean = String(value || "?").replace(/[^a-zA-ZÀ-ÿ0-9 ]/g, " ").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function cutText(text, max) {
  if (!text) return "—";
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function safe(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return String(value ?? "").replaceAll("'", "&#39;").replaceAll('"', "&quot;");
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/([@.])/g, "\\$1");
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.querySelector("span").textContent = message;
  toast.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}
