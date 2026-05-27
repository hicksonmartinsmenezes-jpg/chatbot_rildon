// 03-navigation.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const sidebar = document.getElementById("sidebar");
const btnMenu = document.getElementById("btn-menu");
if (btnMenu) btnMenu.addEventListener("click", () => sidebar.classList.toggle("open"));

// ─── Navegação ────────────────────────────────────────────────────────────────
function switchTab(tab, event) {

  if (tab === "logs") {
    loadActivityLogs();
  }

  if (tab === "metrics") {
    loadTickets();
    setTimeout(() => loadMetricsCharts(), 300);
  }

  currentTab = tab;

  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".sidebar a").forEach(a => a.classList.remove("active"));

  if (event?.currentTarget?.classList.contains("tab")) {
    event.currentTarget.classList.add("active");
  }

  if (event?.currentTarget?.tagName === "A") {
    event.currentTarget.classList.add("active");
    const relatedTab = document.querySelector(`.tab[onclick*="${tab}"]`);
    if (relatedTab) relatedTab.classList.add("active");
  }

  document.querySelectorAll("[id^='tab-']").forEach(s => s.classList.add("hidden"));
  document.getElementById(`tab-${tab}`)?.classList.remove("hidden");

  if (tab === "dashboard") {
  loadTickets();
  loadHistory(false);
}
  if (tab === "tickets")       loadTickets();
  if (tab === "history")       loadHistory(true);
  if (tab === "conversations") loadConversations();
  if (tab === "settings")      { loadSettings(); loadPanelUsers(); }
  if (tab === "chatbot")       { loadSettings(); loadQuickReplies(); }
}

// ─── Atualização Geral ────────────────────────────────────────────────────────
function refreshAll() {
  loadTickets();
  loadHistory(false);
  if (currentTab === "conversations") loadConversations();
}
