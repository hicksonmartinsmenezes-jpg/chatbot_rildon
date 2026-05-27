// 13-main.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Inicialização ────────────────────────────────────────────────────────────
checkAuth();

if (getSessionToken()) {
  refreshAll();
  const user = getCurrentUser();
  if (user?.perfil === "admin") loadSettings();
}

// Polling automático — não atualiza conversas para não perder o estado do chat
setInterval(() => {
  if (!getSessionToken()) return;
  if (currentTab === "dashboard" || currentTab === "tickets") loadTickets();
  if (currentTab === "history")  loadHistory(true);
}, 15000);

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
