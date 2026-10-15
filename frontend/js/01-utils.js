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
function buildContactPhotoUrl(userId) {
  const id = String(userId || "").trim();
  if (!id || id === "photo" || id === "undefined" || id === "null" || id === "[object Object]") return "";
  const bust = window.__avatarCacheBust || (window.__avatarCacheBust = Date.now());
  return `${BASE}/api/contacts/photo?userId=${encodeURIComponent(id)}&v=${bust}`;
}

function avatarHtml(userId, name, big = false) {
  const photoUrl = buildContactPhotoUrl(userId);
  const fallback = safe(initials(name || formatPhone(userId)));
  // Sem loading="lazy": um <img> display:none com lazy NUNCA entra no viewport,
  // então o navegador nunca o carrega (nem dispara load) e a foto nunca aparece.
  // Eager + display:none carrega normalmente; handleAvatarMediaState revela no load.
  const imgHtml = photoUrl ? `
      <img
        src="${photoUrl}"
        alt="${safeAttr(name || "Contato")}"
        data-avatar-img="true"
        data-avatar-user="${safeAttr(userId)}"
        style="display:none;"
      >` : "";

  return `
    <span class="chat-avatar ${big ? "big" : ""}">
      ${imgHtml}
      <span class="avatar-fallback">
        ${fallback}
      </span>
    </span>
  `;
}

function handleAvatarImageError(img) {
  if (!img) return;
  const wrapper = img.closest?.(".chat-avatar, .cp-avatar, .ct-avatar-wrap") || img.parentElement;
  const fallback = wrapper?.querySelector?.(".avatar-fallback, .cp-avatar-ini, .ct-avatar-ini");
  if (fallback) fallback.style.display = "flex";
  img.style.display = "none";
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

function safeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function safeClassName(value, fallback = "unknown") {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return clean || fallback;
}

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

// 2026-10-09 (auditoria de segurança — XSS armazenado CONFIRMADO):
// safe() não escapava aspas, e era usado DENTRO de atributos HTML (o
// alt="${safe(name)}" do avatarHtml, logo acima). Como `name` vem de
// msg.pushName — o nome que o próprio cliente escolhe no WhatsApp dele, sem
// nenhuma sanitização no caminho (config/whatsapp.js grava direto em
// contact_name) — qualquer pessoa de fora podia se nomear com
//     x" onerror="<código>
// mandar uma mensagem qualquer pro número da empresa, e o código rodava no
// painel de TODOS os atendentes, com a sessão deles. O CSP permite
// scriptSrcAttr 'unsafe-inline', então handlers inline funcionam de verdade.
//
// Escapar aspas aqui fecha a classe inteira do problema (os 49 usos de safe()
// no frontend ficam seguros em atributo e em texto — &quot;/&#39; renderizam
// como " e ' normalmente em conteúdo de texto). O uso pontual em atributo
// também foi trocado por safeAttr.
function safe(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return safe(value).replaceAll("'", "&#39;").replaceAll('"', "&quot;");
}


function escapeHtml(value) {
  return safe(value);
}

function safeUrl(value, fallback = "") {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;

  try {
    const url = new URL(raw, window.location.origin);

    if (["http:", "https:", "blob:"].includes(url.protocol)) {
      return url.href;
    }

    // Data URLs somente para imagens raster seguras em previews locais.
    // SVG é bloqueado porque pode carregar scripts/eventos em alguns contextos.
    if (url.protocol === "data:") {
      const allowedDataImage = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(raw);
      return allowedDataImage ? raw : fallback;
    }

    return fallback;
  } catch (_) {
    return fallback;
  }
}


function debounce(fn, delay = 350) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function normalizeId(value) {
  return String(value ?? "").replace(/[^a-zA-Z0-9_.:@-]/g, "");
}

function runExclusive(key, fn) {
  window.__appLocks = window.__appLocks || {};
  if (window.__appLocks[key]) return window.__appLocks[key];

  window.__appLocks[key] = Promise.resolve()
    .then(fn)
    .finally(() => { delete window.__appLocks[key]; });

  return window.__appLocks[key];
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/([@.])/g, "\\$1");
}



// ─── Estados visuais reutilizáveis ───────────────────────────────────────────
function renderEmptyState({ icon = "fa-circle-info", title = "Nada encontrado", message = "", actionText = "", action = "" } = {}) {
  const actionHtml = actionText && action
    ? `<button type="button" class="empty-retry-btn" ${action}>${safe(actionText)}</button>`
    : "";
  return `
    <div class="app-state app-state-empty">
      <i class="fa-solid ${normalizeId(icon) || "fa-circle-info"}" aria-hidden="true"></i>
      <strong>${safe(title)}</strong>
      ${message ? `<small>${safe(message)}</small>` : ""}
      ${actionHtml}
    </div>
  `;
}

function renderErrorState({ title = "Não foi possível carregar os dados", message = "Verifique sua conexão ou tente novamente.", retry = "" } = {}) {
  return renderEmptyState({
    icon: "fa-triangle-exclamation",
    title,
    message,
    actionText: retry ? "Tentar novamente" : "",
    action: retry
  });
}

function setButtonBusy(btn, busy, busyText = "Processando...") {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ${safe(busyText)}`;
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}

function announceToScreenReader(message) {
  let live = document.getElementById("app-live-region");
  if (!live) {
    live = document.createElement("div");
    live.id = "app-live-region";
    live.className = "sr-only";
    live.setAttribute("aria-live", "polite");
    document.body.appendChild(live);
  }
  live.textContent = String(message || "");
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

// ─── Abertura/fechamento animado de overlays (modais, dropdowns) ─────────────
// Substitui o toggle instantâneo de ".hidden" (display:none imediato, sem
// saída) por um enter/exit de verdade via 19-motion.css
// (.motion-overlay-in / .motion-overlay-out). Uso: chamar openWithMotion no
// lugar de `el.classList.remove("hidden")`, e closeWithMotion no lugar de
// `el.classList.add("hidden")`.
function openWithMotion(el) {
  if (!el) return;
  el.classList.remove("motion-overlay-out");
  el.classList.remove("hidden");
  void el.offsetWidth; // força reflow pra reiniciar a animação
  el.classList.add("motion-overlay-in");
}

function closeWithMotion(el, duration = 160) {
  if (!el || el.classList.contains("hidden")) return;
  el.classList.remove("motion-overlay-in");
  void el.offsetWidth;
  el.classList.add("motion-overlay-out");
  setTimeout(() => {
    el.classList.add("hidden");
    el.classList.remove("motion-overlay-out");
  }, duration);
}

// ─── Stagger de entrada em listas ─────────────────────────────────────────────
// Aplica a animação de entrada (19-motion.css .stagger-in) só quando faz
// sentido: primeiro carregamento real (saindo do skeleton), nunca em
// polling silencioso — reforça a regra de frequência do motion (ação
// repetitiva e automática não deve animar toda vez).
function applyStaggerIn(container) {
  if (!container) return;
  container.classList.remove("stagger-in");
  void container.offsetWidth;
  container.classList.add("stagger-in");
}

// ─── Skeleton de lista genérico ───────────────────────────────────────────────
// Gera N linhas de skeleton (avatar + 2 linhas de texto) pra substituir o
// antigo "Carregando..." nas listas do painel.
function renderSkeletonList(count = 5) {
  let html = "";
  for (let i = 0; i < count; i++) {
    html += `
      <div class="skeleton-list-item">
        <div class="skeleton-avatar"></div>
        <div class="skeleton-lines">
          <div class="skeleton-line w-60"></div>
          <div class="skeleton-line w-40"></div>
        </div>
      </div>`;
  }
  return html;
}

// ─── Skeleton de grid genérico (cards) ────────────────────────────────────────
// Mesma ideia de renderSkeletonList, mas em grade de cards — usado no
// Catálogo enquanto a busca de produtos está em voo.
function renderSkeletonGrid(count = 8) {
  let html = `<div class="catalogo-grid skeleton-grid">`;
  for (let i = 0; i < count; i++) {
    html += `<div class="skeleton-card"></div>`;
  }
  html += `</div>`;
  return html;
}

// ─── Skeleton de tabela (linhas <tr>) ─────────────────────────────────────────
// Pra tabelas (ex: Contatos) — <tr> não anima bem com transform em todos os
// browsers, então aqui é só o shimmer estático (sem stagger de entrada).
function renderSkeletonTableRows(cols, rows = 5) {
  let html = "";
  for (let r = 0; r < rows; r++) {
    html += `<tr class="skeleton-tr">`;
    for (let c = 0; c < cols; c++) {
      html += `<td><div class="skeleton-row"></div></td>`;
    }
    html += `</tr>`;
  }
  return html;
}

// ─── Lazy image: fade-in ao carregar ──────────────────────────────────────────
// Marca <img loading="lazy"> como carregada (CSS em 19-motion.css cuida do
// fade). Chamar depois de inserir HTML com imagens lazy no DOM.
function bindLazyImageFade(root = document) {
  root.querySelectorAll('img[loading="lazy"]:not(.is-loaded)').forEach(img => {
    if (img.complete && img.naturalWidth > 0) {
      img.classList.add("is-loaded");
      return;
    }
    img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
    img.addEventListener("error", () => img.classList.add("is-loaded"), { once: true });
  });
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

// ─── Acessibilidade progressiva ──────────────────────────────────────────────
// Garante nome acessível para botões criados pelo HTML ou renderizados via JS.
const ACCESSIBLE_ACTION_LABELS = {
  togglePasswordVisibility: 'Mostrar ou ocultar senha',
  refreshAll: 'Atualizar painel',
  toggleTheme: 'Alternar tema claro ou escuro',
  toggleNotifDropdown: 'Abrir notificações',
  clearNotifications: 'Limpar notificações',
  openProfileModal: 'Abrir perfil',
  logout: 'Sair do sistema',
  loadTickets: 'Atualizar atendimentos',
  loadConversations: 'Atualizar conversas',
  sendConversationMessage: 'Enviar mensagem',
  clearHistoryFilters: 'Limpar filtros do histórico',
  bulkDeleteContacts: 'Excluir contatos selecionados',
  openContactModal: 'Adicionar contato',
  importContactsCSV: 'Importar contatos CSV',
  exportContactsCSV: 'Exportar contatos CSV',
  contactsPagePrev: 'Página anterior de contatos',
  contactsPageNext: 'Próxima página de contatos',
  closeContactModal: 'Fechar janela de contato',
  saveContact: 'Salvar contato',
  closeDeleteContactModal: 'Cancelar exclusão de contato',
  doDeleteContact: 'Confirmar exclusão de contato',
  loadCampaigns: 'Atualizar campanhas',
  openCampaignModal: 'Nova campanha',
  closeCampaignModal: 'Fechar janela de campanha',
  removeCampaignMedia: 'Remover mídia da campanha',
  campSelectAll: 'Selecionar todos os contatos da campanha',
  campClearAll: 'Limpar seleção de contatos da campanha',
  createCampaign: 'Criar campanha',
  saveBotSettings: 'Salvar configurações do bot',
  addQuickReply: 'Adicionar resposta rápida',
  saveFlow: 'Salvar fluxo',
  loadSettings: 'Carregar configurações',
  saveSettings: 'Salvar configurações',
  backToSettingsHome: 'Voltar para configurações',
  createPanelUser: 'Criar usuário',
  resetSettings: 'Restaurar configurações',
  requestWaReconnect: 'Reconectar WhatsApp',
  loadMetricsCharts: 'Atualizar métricas',
  fecharChat: 'Fechar chat',
  enviarMensagemManual: 'Enviar mensagem manual',
  closeProfileModal: 'Fechar perfil',
  saveProfile: 'Salvar perfil',
};

function getButtonAccessibleName(btn) {
  const explicit = btn.getAttribute('aria-label')?.trim();
  if (explicit) return explicit;

  const title = btn.getAttribute('title')?.trim();
  if (title) return title;

  const text = btn.textContent?.replace(/\s+/g, ' ').trim();
  const iconOnly = !text || text.length <= 2;
  if (text && !iconOnly) return text;

  const action = btn.dataset?.action;
  if (action && ACCESSIBLE_ACTION_LABELS[action]) return ACCESSIBLE_ACTION_LABELS[action];

  const tab = btn.dataset?.tab;
  if (tab) return `Abrir aba ${tab}`;

  return '';
}

function enhanceButtonAccessibility(root = document) {
  const buttons = root.querySelectorAll?.('button') || [];
  buttons.forEach(btn => {
    const name = getButtonAccessibleName(btn);
    if (!name) return;
    if (!btn.hasAttribute('aria-label')) btn.setAttribute('aria-label', name);
    if (!btn.hasAttribute('title') && btn.classList.contains('icon-btn')) btn.setAttribute('title', name);
  });
}

function observeDynamicAccessibility() {
  if (!('MutationObserver' in window) || !document.body) return;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (node.matches?.('button')) enhanceButtonAccessibility(node.parentElement || document);
        else if (node.querySelector?.('button')) enhanceButtonAccessibility(node);
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function handleAvatarMediaState(event) {
  const img = event.target;
  if (!(img instanceof HTMLImageElement)) return;

  const isKnownAvatar =
    img.dataset.avatarImg === "true" ||
    img.classList.contains("cp-avatar-img") ||
    img.classList.contains("contact-avatar-img");

  if (!isKnownAvatar) return;

  const wrapper = img.closest?.(".chat-avatar, .cp-avatar, .ct-avatar-wrap") || img.parentElement;
  const fallback = wrapper?.querySelector?.(".avatar-fallback, .cp-avatar-ini, .ct-avatar-ini") || null;

  if (event.type === "load") {
    // Respostas 204/sem corpo podem disparar load, mas não exibem imagem real.
    if (!img.naturalWidth || !img.naturalHeight) {
      img.style.display = "none";
      if (fallback) fallback.style.display = "flex";
      return;
    }
    img.style.display = "block";
    if (fallback) fallback.style.display = "none";
    return;
  }

  img.style.display = "none";
  if (fallback) fallback.style.display = "flex";
}

document.addEventListener("error", handleAvatarMediaState, true);
document.addEventListener("load", handleAvatarMediaState, true);

document.addEventListener('DOMContentLoaded', () => {
  enhanceButtonAccessibility(document);
  observeDynamicAccessibility();
  document.body.classList.toggle('is-offline', !navigator.onLine);

  window.addEventListener('offline', () => {
    document.body.classList.add('is-offline');
    showToast?.('Você está offline. Algumas ações podem falhar.', 'warning');
    announceToScreenReader('Você está offline.');
  });

  window.addEventListener('online', () => {
    document.body.classList.remove('is-offline');
    showToast?.('Conexão restabelecida.', 'success');
    announceToScreenReader('Conexão restabelecida.');
    if (typeof refreshAll === 'function') refreshAll();
  });

});
