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
