// 13-main.js

// ─── Inicialização ────────────────────────────────────────────────────────────
checkAuth();

// Pré-preenche filtros de data com o dia atual e conecta auto-refresh
// BUG CORRIGIDO (varredura 2026-10-15): os dois campos abriam preenchidos
// com HOJE, e loadTickets manda isso pro backend — a lista de Atendimentos
// vinha vazia e o Dashboard parecia zerado sempre que nenhum ticket tinha
// sido criado no dia (com o bot desligado, isso virou o normal). Agora o
// padrao e uma janela de 30 dias (inicio = hoje-29, fim = hoje), que mostra
// movimento de verdade; o usuario continua livre pra trocar as datas.
const DIAS_FILTRO_PADRAO = 30;
(function initDateFilters() {
  function iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const hoje = new Date();
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - (DIAS_FILTRO_PADRAO - 1));

  const startEl = document.getElementById("date-start");
  const endEl   = document.getElementById("date-end");

  if (startEl && !startEl.value) {
    startEl.value = iso(inicio);
    startEl.addEventListener("change", loadTickets);
  }
  if (endEl && !endEl.value) {
    endEl.value = iso(hoje);
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
  if (_pollId !== null) return _pollId;
  _pollId = setInterval(() => {
    if (!getCurrentUser()) return;
    if (currentTab === "dashboard" || currentTab === "tickets") loadTickets(true);
    if (currentTab === "history") loadHistory(true);
    if (currentTab === "conversations") loadConversations(true);
  }, 30000);
  return _pollId;
}

function stopPolling() {
  if (_pollId !== null) {
    clearInterval(_pollId);
    _pollId = null;
  }
}

startPolling();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    // Ao voltar para a aba, força uma atualização imediata e reinicia o poll
    if (getCurrentUser()) {
      if (currentTab === "dashboard" || currentTab === "tickets") loadTickets(true);
      if (currentTab === "history") loadHistory(true);
      if (currentTab === "conversations") loadConversations(true);
    }
    startPolling();
  }
});

// ─── Helpers de painel bot ────────────────────────────────────────────────────
function switchBotPanel(panelId, event) {
  document.querySelectorAll(".bot-panel").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.getElementById(panelId)?.classList.remove("hidden");
  event?.currentTarget?.classList.add("active");
}

function saveBotSettings() { return saveSettings(); }
function saveFlow() { return saveSettings(); }

let _serverStatusPollId = null;

function startServerStatusPolling() {
  if (_serverStatusPollId !== null) return;
  checkServerStatus();
  _serverStatusPollId = setInterval(() => {
    if (!document.hidden && getCurrentUser()) checkServerStatus();
  }, 20000);
}

function stopServerStatusPolling() {
  if (_serverStatusPollId !== null) {
    clearInterval(_serverStatusPollId);
    _serverStatusPollId = null;
  }
}

startServerStatusPolling();

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopServerStatusPolling();
  else if (getCurrentUser()) startServerStatusPolling();
});
