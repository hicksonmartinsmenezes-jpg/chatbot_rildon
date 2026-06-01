// 13-main.js

// ─── Inicialização ────────────────────────────────────────────────────────────
checkAuth();

if (getSessionToken()) {
  refreshAll();
  const user = getCurrentUser();
  if (user?.perfil === "admin") loadSettings();
}

// ─── Polling inteligente (pausa quando aba oculta) ────────────────────────────
let _pollId = null;

function startPolling() {
  return setInterval(() => {
    if (!getSessionToken()) return;
    if (currentTab === "dashboard" || currentTab === "tickets") loadTickets();
    if (currentTab === "history") loadHistory(true);
  }, 15000);
}

function stopPolling() {
  if (_pollId !== null) {
    clearInterval(_pollId);
    _pollId = null;
  }
}

_pollId = startPolling();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    // Ao voltar para a aba, força uma atualização imediata e reinicia o poll
    if (getSessionToken()) {
      if (currentTab === "dashboard" || currentTab === "tickets") loadTickets();
      if (currentTab === "history") loadHistory(true);
    }
    _pollId = startPolling();
  }
});

// ─── Helpers de painel bot ────────────────────────────────────────────────────
function switchBotPanel(panelId, event) {
  document.querySelectorAll(".bot-panel").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.getElementById(panelId)?.classList.remove("hidden");
  event?.currentTarget?.classList.add("active");
}

const saveBotSettings = () => saveSettings();
const saveFlow        = () => saveSettings();

checkServerStatus();
setInterval(checkServerStatus, 5000);
