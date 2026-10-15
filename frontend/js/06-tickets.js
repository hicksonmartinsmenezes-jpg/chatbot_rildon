// 06-tickets.js

// ─── Tickets ──────────────────────────────────────────────────────────────────
// silent=true → atualiza sem mostrar skeleton (evita flash em polling/socket
// automático; mesmo padrão de loadConversations, ver 07-conversations.js)
async function loadTickets(silent = false) {
  return runExclusive("loadTickets", () => _loadTicketsCore(silent));
}

async function _loadTicketsCore(silent = false) {
  const search    = document.getElementById("search")?.value || "";
  const status    = document.getElementById("filter-status")?.value || "";
  const container = document.getElementById("tickets-container");

  if (!silent && container) container.innerHTML = renderSkeletonList(5);

  try {
    const dateStart = document.getElementById("date-start")?.value || "";
    const dateEnd   = document.getElementById("date-end")?.value   || "";

    const params = new URLSearchParams();
    if (search)    params.append("search",    search);
    if (status)    params.append("status",    status);
    if (dateStart) params.append("dateStart", dateStart);
    if (dateEnd)   params.append("dateEnd",   dateEnd);

    const res = await apiFetch(`${BASE}/api/tickets?${params}`);
    if (!res) return;
    const data = await res.json();

    updateStats(data.stats, data.tickets || [], data.liveStats, data.todayStats, data.encerradosHoje);

    // Mesmo corte do nova_mensagem (12-socket.js) — usuário sem a tela
    // "Atendimentos" não deve receber alerta de novo atendimento (pedido
    // do usuário, 2026-09-21).
    const podeVerAtendimentos = typeof hasUserScreenPermission !== "function" || hasUserScreenPermission("conversations");
    if (!firstLoadTickets && data.total > lastTicketTotal && podeVerAtendimentos) showNewTicketAlert();

    lastTicketTotal  = data.total;
    firstLoadTickets = false;

    if (!container) return;

    if (!data.tickets?.length) {
      container.innerHTML = `<p class="empty">Nenhum atendimento encontrado.</p>`;
      return;
    }

    container.innerHTML = data.tickets.map(renderTicketCard).join("");
    bindTicketActionDelegation();
    if (!silent) applyStaggerIn(container);
  } catch (err) {
    if (container) container.innerHTML = `<p class="empty">❌ Erro ao carregar atendimentos.</p>`;
  }
}

async function mudarStatus(id, status) {
  // Confirmação antes de ações destrutivas
  if (status === "cancelado") {
    showConfirmModal({
      title:       "Cancelar ticket",
      message:     `Tem certeza que deseja cancelar o ticket #${id}? Esta ação não pode ser desfeita.`,
      confirmText: "Sim, cancelar",
      danger:      true,
      onConfirm:   () => _executarMudarStatus(id, status)
    });
    return;
  }
  await _executarMudarStatus(id, status);
}

// BUG CORRIGIDO (relatado pelo usuário): o botão "Resolvido" não tinha
// loading/disable — clicar 2x seguidas rápido (achando que a 1ª não
// funcionou, já que nada muda na tela até a resposta chegar) disparava 2
// requisições PATCH em voo ao mesmo tempo, e cada uma reenviava a pesquisa
// de satisfação pro cliente. runExclusive (mesmo padrão já usado em
// loadTickets) dedup por id: o 2º clique enquanto o 1º ainda está em voo
// reaproveita a MESMA promise, em vez de disparar uma requisição nova.
async function _executarMudarStatus(id, status) {
  return runExclusive(`mudarStatus:${id}`, async () => {
    try {
      const res = await apiFetch(`${BASE}/api/tickets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status })
      });
      if (!res) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Não foi possível atualizar o ticket.", "error");
        return;
      }
      showToast("✅ Status atualizado!", "success");
      loadTickets();
      if (currentTab === "metrics") loadMetricsCharts();
    } catch {
      showToast("Não foi possível atualizar o ticket.", "error");
    }
  });
}

function updateStats(stats, tickets = [], liveStats = null, todayStats = null, encerradosHoje = null) {
  if (!stats) return;

  // Pedido do usuário (2026-08-14): "Total de atendimentos" é sempre HOJE,
  // fixo — não muda com o filtro de data do topo (mesmo padrão que
  // Encerrados já seguia). todayStats vem do backend já filtrado por
  // created_at = hoje (fuso do negócio), independente de dateStart/dateEnd.
  const hojeBase  = todayStats || stats;
  const total     = hojeBase.total ?? 0;
  const resolvido = stats.resolvido ?? stats.resolvidos ?? 0;
  const cancelado = stats.cancelado ?? stats.cancelados ?? 0;

  // Cards de estado atual usam liveStats (sem filtro de data) para bater com as abas de Atendimentos
  const live      = liveStats || stats;
  const aberto    = live.aberto ?? live.abertos ?? 0;
  const andamento = live.em_andamento ?? 0;

  // Migration 026: Encerrados hoje vem pronto do backend (encerradosHoje),
  // contado por closed_at (quando o ticket REALMENTE fechou) — não mais
  // aproximado por "criado hoje + status atual", que perdia ticket aberto
  // num dia e fechado no seguinte.
  const encerrados = encerradosHoje ?? ((hojeBase.resolvido ?? 0) + (hojeBase.cancelado ?? 0));

  // setTextPop (Issue #14): pop de escala quando o valor muda de verdade —
  // esses 4 cards atualizam sozinhos em tempo real (polling/socket), sem
  // esse feedback o usuário não notava quando um número novo chegava.
  setTextPop("stat-total",    total);
  setTextPop("stat-aberto",   aberto);    // Pendentes = aberto (todos, sem filtro de data)
  setTextPop("stat-andamento",andamento); // Ativos    = em_andamento (todos)
  setText("stat-resolvido",resolvido);
  setTextPop("stat-encerrados",encerrados);  // Encerrados = fechados (closed_at) HOJE
  setText("stat-contatos", new Set((tickets || []).map(t => t.userId)).size);

  setText("op-aberto",    aberto);
  setText("op-andamento", andamento);
  setText("op-resolvido", resolvido);
  setText("op-cancelado", cancelado);

  renderExecutiveDashboard(tickets, { total, aberto, andamento, resolvido, cancelado });
}

function renderExecutiveDashboard(tickets = [], stats = {}) {
  const lista = Array.isArray(tickets) ? tickets : [];

  // BUG CORRIGIDO (varredura 2026-10-15): comparava toISOString() (UTC)
  // com a data do ticket em UTC — das 21h à meia-noite no horário local o
  // "hoje" já era o dia seguinte e o card contava errado. Agora compara a
  // data no fuso de quem está olhando.
  const diaLocal = (valor) => {
    const d = new Date(valor);
    return Number.isNaN(d.getTime())
      ? null
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const hoje = diaLocal(new Date());
  const ticketsHoje = lista.filter(ticket => {
    const data = ticket.createdAt || ticket.created_at;
    return data && diaLocal(data) === hoje;
  }).length;

  setText("stat-hoje", ticketsHoje);

  const total      = Number(stats.total    || 0);
  const resolvido  = Number(stats.resolvido|| 0);
  const taxaResolucao = total > 0 ? Math.round((resolvido / total) * 100) : 0;
  setText("stat-resolucao-sub", `${taxaResolucao}% de resolução geral`);
  setText("stat-total-sub",     `${ticketsHoje} novo(s) hoje`);

  const porSetor  = contarPorCampo(lista, "sector");
  const setorTop  = Object.entries(porSetor).sort((a, b) => b[1] - a[1])[0];
  setText("stat-top-sector", setorTop ? setorTop[0] : "—");

  renderRecentTickets(lista);
  renderExecutiveCharts(lista, porSetor);
}

function contarPorCampo(lista, campo) {
  return lista.reduce((acc, item) => {
    const chave = item?.[campo] || "geral";
    acc[chave]  = (acc[chave] || 0) + 1;
    return acc;
  }, {});
}

function renderRecentTickets(tickets = []) {
  const container = document.getElementById("dashboard-recent-tickets");
  if (!container) return;

  const recentes = [...tickets]
    .sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0))
    .slice(0, 5);

  if (!recentes.length) {
    container.innerHTML = `<p class="empty-mini">Nenhum ticket recente.</p>`;
    return;
  }

  container.innerHTML = recentes.map(ticket => `
    <div class="recent-ticket-item">
      <div>
        <strong>#${safe(ticket.protocolo || ticket.id || "—")} — ${safe(tipoLabel(ticket.type || "geral"))}</strong>
        <span>${safe(ticket.customerName || "Cliente não informado")}</span>
      </div>
      <small>${safe(statusLabel(ticket.status || "aberto"))}</small>
    </div>
  `).join("");
}

function renderExecutiveCharts(tickets = [], porSetor = {}) {
  if (typeof Chart === "undefined") return;

  const porDia = tickets.reduce((acc, ticket) => {
    const dataBruta = ticket.createdAt || ticket.created_at;
    const dia = dataBruta ? String(dataBruta).slice(0, 10) : "Sem data";
    acc[dia] = (acc[dia] || 0) + 1;
    return acc;
  }, {});

  const diasOrdenados = Object.keys(porDia).sort().slice(-7);

  upsertChart("exec-chart-day", "line", {
    labels:   diasOrdenados.length ? diasOrdenados : ["Hoje"],
    datasets: [{
      label:       "Atendimentos",
      data:        diasOrdenados.length ? diasOrdenados.map(d => porDia[d]) : [0],
      tension:     0.36,
      fill:        true,
      borderWidth: 2
    }]
  });

  const setores = Object.keys(porSetor);
  upsertChart("exec-chart-sector", "bar", {
    labels:   setores.length ? setores : ["Sem setor"],
    datasets: [{
      label:         "Tickets",
      data:          setores.length ? setores.map(s => porSetor[s]) : [0],
      borderRadius:  12,
      borderSkipped: false
    }]
  });
}

async function checkServerStatus() {
  try {
    const res = await fetch(`${BASE}/health`, { cache: "no-store" });
    if (!res.ok) throw new Error();
    setOnline();
  } catch {
    setOffline();
  }
}

// BUG CORRIGIDO: antes, cada chamada criava um "new AudioContext()" novo e
// nunca fechava/reaproveitava — em uma sessão longa e movimentada (muitas
// mensagens/tickets no dia), isso acumula contextos de áudio nunca liberados,
// o que pode fazer o navegador silenciosamente parar de tocar o som após um
// tempo (limite de contextos simultâneos do navegador), sem nenhum erro
// visível (o catch(_) engolia tudo). Agora reaproveita UM único contexto
// compartilhado e garante que ele esteja "resumed" antes de tocar.
let _alertAudioCtx = null;
function _getAlertAudioCtx() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!_alertAudioCtx) _alertAudioCtx = new AudioCtx();
  if (_alertAudioCtx.state === "suspended") _alertAudioCtx.resume().catch(() => {});
  return _alertAudioCtx;
}

function playAlertSound(type = "ticket") {
  try {
    // Gera o som localmente para evitar 404 de /sounds/message.ogg ou /sounds/ticket.ogg.
    const ctx = _getAlertAudioCtx();
    if (!ctx) return;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = type === "message" ? 880 : 660;
    gain.gain.setValueAtTime(0.22, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (_) {}
}

function showNewTicketAlert(userId, name) {
  document.querySelector(".notification")?.classList.add("has-alert");
  playAlertSound("ticket");
  showToast("🎫 Novo atendimento recebido!");
  if (typeof pushNotification === "function") {
    pushNotification("ticket", `Novo atendimento${name ? ": " + name : ""}`, userId);
  }
}

// ─── Assumir / Transferir Ticket ─────────────────────────────────────────────
async function assumirTicket(id) {
  try {
    const res = await apiFetch(`${BASE}/api/tickets/${id}/assign`, { method: "PATCH" });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao assumir ticket.");

    showToast("✅ Ticket assumido!");

    if (data.ticket?.userId) {
      currentTab = "conversations";
      switchTab("conversations");
      await loadConversations();
      openConversation(data.ticket.userId);
    } else {
      loadTickets();
      if (currentTab === "metrics") loadMetricsCharts();
    }
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// Substitui prompt() por modal de confirmação
async function transferirTicket(id) {
  showInputModal({
    title:       "Transferir ticket",
    label:       "Para qual setor?",
    placeholder: "vendas, financeiro, suporte, garantia",
    confirmText: "Transferir",
    onConfirm:   async (sector) => {
      if (!sector) return;
      const sectorNorm = sector.trim().toLowerCase();
      try {
        const res = await apiFetch(`${BASE}/api/tickets/${id}/transfer`, {
          method: "PATCH",
          body:   JSON.stringify({ sector: sectorNorm })
        });
        if (!res) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erro ao transferir ticket.");
        showToast("✅ Ticket transferido!");
        loadTickets();
        if (currentTab === "metrics") loadMetricsCharts();
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    }
  });
}

// ─── Gráficos do dashboard admin ──────────────────────────────────────────────
async function loadDashboardCharts() {
  if (typeof Chart === "undefined") return;

  const user = getCurrentUser();
  if (!["admin", "supervisor"].includes(user?.perfil)) return;

  try {
    const res = await apiFetch(`${BASE}/api/tickets/dashboard`);
    if (!res) return;
    const data = await res.json();

    const statusChart = upsertChart("chart-status", "doughnut", {
      labels:   Object.keys(data.porStatus  || {}),
      datasets: [{ data: Object.values(data.porStatus || {}) }]
    });
    const sectorChart = upsertChart("chart-sector", "bar", {
      labels:   Object.keys(data.porSetor  || {}),
      datasets: [{ label: "Atendimentos", data: Object.values(data.porSetor || {}) }]
    });

    // Mantém referências globais de compatibilidade
    AppState.chartStatus = statusChart;
    AppState.chartSector = sectorChart;
  } catch (_) {}
}
