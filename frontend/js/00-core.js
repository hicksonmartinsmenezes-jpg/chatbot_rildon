// 00-core.js

// ─── Estado Global (encapsulado) ──────────────────────────────────────────────
const BASE = window.location.origin;

const AppState = {
  currentTab:                  "dashboard",
  lastTicketTotal:             0,
  firstLoadTickets:            true,
  selectedConversationUser:    null,
  allHistory:                  [],
  currentChatUser:             null,
  unreadMessages:              {},
  chartStatus:                 null,
  chartSector:                 null,
  sendingConversationMessage:  false,
  metricDayChart:              null,

  set(key, val) {
    this[key] = val;
  },
  get(key) {
    return this[key];
  }
};

// ─── Tema claro/escuro (preferência por navegador, por usuário) ───────────────
// Funciona para qualquer perfil (não depende de /api/settings, que é admin-only)
// e persiste no localStorage do navegador.
function applyTheme(theme) {
  const isLight = theme === "light";
  document.body.classList.toggle("light-theme", isLight);
  const icon = document.querySelector("#theme-toggle i");
  if (icon) icon.className = isLight ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

function getStoredTheme() {
  try { return localStorage.getItem("panel_theme"); } catch (_) { return null; }
}

function toggleTheme() {
  const next = document.body.classList.contains("light-theme") ? "dark" : "light";
  try { localStorage.setItem("panel_theme", next); } catch (_) {}
  applyTheme(next);
}

// Aplica imediatamente o tema salvo (00-core roda no fim do <body>, então
// document.body e o botão já existem — sem flash perceptível).
(function initTheme() {
  const stored = getStoredTheme();
  if (stored) applyTheme(stored);
})();

// ─── Persistência do contador de não lidas ────────────────────────────────────
// BUG CORRIGIDO: unreadMessages vivia só em AppState (memória) — um F5/refresh
// zerava tudo, mesmo que o atendente não tivesse aberto a conversa e visto as
// mensagens de verdade. Parecia que "sumiu" a mensagem nova, quando na
// verdade só a página recarregou. Agora persiste no localStorage, por
// usuário logado (mesma convenção da chave "profile_<usuario>" em
// 02-auth.js), e é restaurado logo após confirmar a sessão — ver
// restoreUnreadMessages() chamado em login()/submitTwoFactorLogin()/checkAuth()
// no 02-auth.js.
// Limitação conhecida: só conta mensagens recebidas enquanto o painel estava
// aberto (via socket "nova_mensagem" em 12-socket.js) — mensagens chegadas
// com o navegador totalmente fechado não entram nessa contagem, pois não
// existe hoje um campo de "última leitura" calculado no backend.
function _unreadStorageKey() {
  const user = typeof getCurrentUser === "function" ? getCurrentUser() : null;
  const id = user?.usuario || user?.id;
  return id ? `unread_msgs_${id}` : null;
}

function persistUnreadMessages() {
  const key = _unreadStorageKey();
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(AppState.unreadMessages)); } catch (_) {}
}

function restoreUnreadMessages() {
  const key = _unreadStorageKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (raw) AppState.unreadMessages = JSON.parse(raw) || {};
  } catch (_) {}
  if (typeof updateSidebarUnreadBadge === "function") updateSidebarUnreadBadge();
}

// Compatibilidade com código legado que usa variáveis soltas
Object.defineProperties(window, {
  currentTab:               { get: () => AppState.currentTab,               set: v => AppState.currentTab = v,               enumerable: true },
  lastTicketTotal:          { get: () => AppState.lastTicketTotal,          set: v => AppState.lastTicketTotal = v,          enumerable: true },
  firstLoadTickets:         { get: () => AppState.firstLoadTickets,         set: v => AppState.firstLoadTickets = v,         enumerable: true },
  selectedConversationUser: { get: () => AppState.selectedConversationUser, set: v => AppState.selectedConversationUser = v, enumerable: true },
  allHistory:               { get: () => AppState.allHistory,               set: v => AppState.allHistory = v,               enumerable: true },
  currentChatUser:          { get: () => AppState.currentChatUser,          set: v => AppState.currentChatUser = v,          enumerable: true },
  unreadMessages:           { get: () => AppState.unreadMessages,           set: v => AppState.unreadMessages = v,           enumerable: true },
  chartStatus:              { get: () => AppState.chartStatus,              set: v => AppState.chartStatus = v,              enumerable: true },
  chartSector:              { get: () => AppState.chartSector,              set: v => AppState.chartSector = v,              enumerable: true },
  sendingConversationMessage:{ get: () => AppState.sendingConversationMessage, set: v => AppState.sendingConversationMessage = v, enumerable: true },
  metricDayChart:           { get: () => AppState.metricDayChart,           set: v => AppState.metricDayChart = v,           enumerable: true },
});
