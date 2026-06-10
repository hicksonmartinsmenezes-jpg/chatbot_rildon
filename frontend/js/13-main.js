// 13-main.js

// ─── Inicialização ────────────────────────────────────────────────────────────
checkAuth();

// Pré-preenche filtros de data com o dia atual e conecta auto-refresh
(function initDateFilters() {
  const hoje = new Date();
  const yyyy = hoje.getFullYear();
  const mm   = String(hoje.getMonth() + 1).padStart(2, "0");
  const dd   = String(hoje.getDate()).padStart(2, "0");
  const hojeStr = `${yyyy}-${mm}-${dd}`;

  const startEl = document.getElementById("date-start");
  const endEl   = document.getElementById("date-end");

  if (startEl && !startEl.value) {
    startEl.value = hojeStr;
    startEl.addEventListener("change", loadTickets);
  }
  if (endEl && !endEl.value) {
    endEl.value = hojeStr;
    endEl.addEventListener("change", loadTickets);
  }
})();

if (getCurrentUser()) {
  refreshAll();
  const user = getCurrentUser();
  if (user?.perfil === "admin") loadSettings();
}

// ─── Polling inteligente (pausa quando aba oculta) ────────────────────────────
let _pollId = null;

function startPolling() {
  return setInterval(() => {
    if (!getCurrentUser()) return;
    if (currentTab === "dashboard" || currentTab === "tickets") loadTickets();
    if (currentTab === "history") loadHistory(true);
    if (currentTab === "conversations") loadConversations(true);
  }, 30000);
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
    if (getCurrentUser()) {
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
