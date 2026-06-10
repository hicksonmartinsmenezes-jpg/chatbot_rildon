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
      <img
        src="${BASE}/api/contacts/photo?userId=${encodeURIComponent(userId)}&t=${Math.floor(Date.now()/60000)}"
        alt="${safe(name)}"
        loading="lazy"
        onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';"
      >
      <span class="avatar-fallback" style="display:none;">
        ${safe(initials(name))}
      </span>
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

  // Remove sufixos do JID do WhatsApp
  const raw = String(userId)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace("@lid", "")
    .replace(/\D/g, ""); // mantém apenas dígitos

  if (!raw) return "—";

  // Remove código do Brasil (55) se presente e número tiver DDD + número
  let local = raw;
  if (local.startsWith("55") && local.length >= 12 && local.length <= 14) {
    local = local.slice(2);
  }

  // Celular com 9 dígitos: (DDD) 9XXXX-XXXX
  if (local.length === 11) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }
  // Fixo com 8 dígitos: (DDD) XXXX-XXXX
  if (local.length === 10) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  }

  // Número não reconhecido como BR: retorna limpo
  return raw;
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

function relativeTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  const diff  = Date.now() - d.getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return "Agora";
  if (mins  < 60) return `Há ${mins}min`;
  if (hours < 24) return `Há ${hours}h`;
  if (days  < 30) return `Há ${days}d`;
  return d.toLocaleDateString("pt-BR");
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

// ─── Toast com tipos visuais ──────────────────────────────────────────────────
// type: 'success' | 'error' | 'warning' | 'info'
const TOAST_ICONS = {
  success: "fa-circle-check",
  error:   "fa-circle-xmark",
  warning: "fa-triangle-exclamation",
  info:    "fa-circle-info"
};

let _toastTimer = null;
function showToast(message, type = "success") {
  const toast   = document.getElementById("toast");
  if (!toast) return;

  const iconEl  = toast.querySelector("i");
  const spanEl  = toast.querySelector("span");
  if (spanEl) spanEl.textContent = message;

  // Ícone dinâmico por tipo
  if (iconEl) {
    iconEl.className = `fa-solid ${TOAST_ICONS[type] || TOAST_ICONS.success}`;
  }

  // Cor da borda por tipo
  toast.dataset.type = type;

  toast.classList.remove("show");
  void toast.offsetWidth; // força reflow para reiniciar animação
  toast.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}


// ─── Auto-resize de textarea ─────────────────────────────────────────────────
function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 130) + "px";
}

// Reset altura ao limpar textarea programaticamente
function resetTextareaHeight(el) {
  if (!el) return;
  el.style.height = "auto";
}

// ─── Toggle genérico de visibilidade de senha ────────────────────────────────
// Usado em qualquer campo de senha no painel (ex: cadastro de usuário)
function togglePassword(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  const icon = btn.querySelector("i");
  if (icon) {
    icon.className = isHidden ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
  }
}
