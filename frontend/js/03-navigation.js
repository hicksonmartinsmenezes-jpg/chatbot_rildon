// 03-navigation.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const sidebar = document.getElementById("sidebar");
const btnMenu = document.getElementById("btn-menu");
if (btnMenu) btnMenu.addEventListener("click", () => sidebar.classList.toggle("open"));

// ─── Navegação ────────────────────────────────────────────────────────────────
function switchTab(tab, event) {
  // CORRIGIDO: evita scroll pro topo e bug de histórico do navegador
  if (event) event.preventDefault();

  if (tab === "metrics") {
    const p = typeof loadTickets === "function" ? loadTickets() : Promise.resolve();
    Promise.resolve(p).finally(() => { if (typeof loadMetricsCharts === "function") loadMetricsCharts(); });
  }
  if (tab === "channels") {
    if (typeof loadCampaigns === "function") loadCampaigns();
    if (typeof updateCampaignAudienceCount === "function")
      setTimeout(() => updateCampaignAudienceCount(), 100);
  }
  if (tab === "contacts") {
    if (typeof loadContacts === "function") loadContacts();
    if (typeof loadContactsTags === "function") loadContactsTags();
    if (typeof loadContactsAtendenteOptions === "function") loadContactsAtendenteOptions();
  }
  if (tab === "catalogo") {
    if (typeof loadCatalogoSecoes === "function") loadCatalogoSecoes();
    if (typeof loadCatalogoFabricantes === "function") loadCatalogoFabricantes();
    // Foco direto no campo Marca ao abrir a aba — atendente já começa digitando.
    setTimeout(() => document.getElementById("catalogo-marca")?.focus(), 50);
  }

  currentTab = tab;

  // Sincroniza tabs superiores E sidebar ao mesmo tempo
  document.querySelectorAll(".tab").forEach(t => { t.classList.remove("active"); t.removeAttribute("aria-current"); });
  document.querySelectorAll(".sidebar a").forEach(a => { a.classList.remove("active"); a.removeAttribute("aria-current"); });

  // Marca tab superior ativa — usa data-tab se disponível, fallback para onclick*=
  document.querySelectorAll(`.tab[data-tab="${tab}"], .tab[onclick*="'${tab}'"]`).forEach(t => { t.classList.add("active"); t.setAttribute("aria-current", "page"); });
  // Marca item do sidebar ativo
  document.querySelectorAll(`.sidebar a[data-tab="${tab}"], .sidebar a[onclick*="'${tab}'"]`).forEach(a => { a.classList.add("active"); a.setAttribute("aria-current", "page"); });
  // Também marca o elemento que disparou o evento.
  // Em navegação por delegação, event.currentTarget é o document,
  // não o botão/link clicado. Usar currentTarget direto quebrava os cliques
  // do menu com erro em classList.
  const clickedTab = event?.target?.closest?.('[data-tab]') || null;
  if (clickedTab?.classList) {
    clickedTab.classList.add("active");
    clickedTab.setAttribute("aria-current", "page");
  }
  if (sidebar?.classList.contains("open")) sidebar.classList.remove("open");

  document.querySelectorAll("[id^='tab-']").forEach(s => s.classList.add("hidden"));
  document.getElementById(`tab-${tab}`)?.classList.remove("hidden");

  // Oculta o painel de abas superiores quando está em Atendimentos
  document.body.classList.toggle("tab-fullscreen", tab === "conversations");

  // Pedido do usuário: o topbar de tabs (Painel/Atendimentos/Histórico/
  // Chatbot) só deve aparecer na aba Dashboard — nas demais abas some
  // (a navegação principal já é feita pela sidebar).
  document.body.classList.toggle("hide-top-tabs", tab !== "dashboard");

  if (tab === "dashboard") {
    if (typeof loadTickets === "function") loadTickets();
    if (typeof loadHistory === "function") loadHistory(false);
  }
  if (tab === "tickets" && typeof loadTickets === "function") loadTickets();
  if (tab === "history" && typeof loadHistory === "function") loadHistory(true);
  if (tab === "conversations" && typeof loadConversations === "function") loadConversations();
  if (tab === "settings") {
    if (typeof loadSettings === "function") loadSettings();
    if (typeof loadPanelUsers === "function") loadPanelUsers();
  }
  if (tab === "chatbot") {
    if (typeof loadSettings === "function") loadSettings();
    if (typeof loadQuickReplies === "function") loadQuickReplies();
  }
}

// ─── Atualização Geral ────────────────────────────────────────────────────────
function refreshAll() {
  return runExclusive('refresh-all', async () => {
    await Promise.allSettled([
      typeof loadTickets === 'function' ? loadTickets() : null,
      typeof loadHistory === 'function' ? loadHistory(false) : null,
      currentTab === "conversations" && typeof loadConversations === 'function' ? loadConversations() : null
    ].filter(Boolean));
  });
}

// Delegação para navegação declarativa via data-tab.
// Reduz handlers inline no HTML e mantém o comportamento antigo como fallback.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-tab]");
  if (!trigger) return;
  const tab = trigger.getAttribute("data-tab");
  if (!tab) return;
  switchTab(tab, event);
});
