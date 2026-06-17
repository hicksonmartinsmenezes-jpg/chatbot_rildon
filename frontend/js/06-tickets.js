// 06-tickets.js

// ─── Tickets ──────────────────────────────────────────────────────────────────
async function loadTickets() {
  const search    = document.getElementById("search")?.value || "";
  const status    = document.getElementById("filter-status")?.value || "";
  const container = document.getElementById("tickets-container");

  if (container) container.innerHTML = `<p class="loading">Carregando atendimentos...</p>`;

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

    updateStats(data.stats, data.tickets || [], data.liveStats);

    if (!firstLoadTickets && data.total > lastTicketTotal) showNewTicketAlert();

    lastTicketTotal  = data.total;
    firstLoadTickets = false;

    if (!container) return;

    if (!data.tickets?.length) {
      container.innerHTML = `<p class="empty">Nenhum atendimento encontrado.</p>`;
      return;
    }

    container.innerHTML = data.tickets.map(ticket => `
      <div class="ticket-card ${ticket.status} ${ticket.status === "aberto" ? "novo-ticket" : ""}" id="card-${escapeAttr(String(ticket.id))}">

        <div class="ticket-header">
          <div class="ticket-header-left">
            <span class="ticket-id">#${safe(ticket.protocolo || ticket.id)}</span>
            <span class="ticket-type-badge">${safe(tipoLabel(ticket.type))}</span>
          </div>
          <span class="status-badge status-${ticket.status}">${statusLabel(ticket.status)}</span>
        </div>

        <div class="ticket-meta">
          <div class="ticket-meta-item">
            <i class="fa-solid fa-user" aria-hidden="true"></i>
            <span title="${escapeAttr(ticket.customerName || "Não informado")}">${safe(ticket.customerName || "Não informado")}</span>
          </div>
          <div class="ticket-meta-item">
            <i class="fa-solid fa-mobile-screen" aria-hidden="true"></i>
            <span>${safe(formatPhone(ticket.userId))}</span>
          </div>
          ${ticket.cpf && ticket.cpf !== "Não informado" && ticket.cpf !== "não informado" ? `
          <div class="ticket-meta-item">
            <i class="fa-solid fa-id-card" aria-hidden="true"></i>
            <span>${safe(ticket.cpf)}</span>
          </div>` : ""}
          ${ticket.sector ? `
          <div class="ticket-meta-item">
            <i class="fa-solid fa-layer-group" aria-hidden="true"></i>
            <span>${safe(ticket.sector)}</span>
          </div>` : ""}
        </div>

        ${ticket.description ? `<div class="desc">${safe(ticket.description)}</div>` : ""}

        <div class="ticket-footer-meta">
          <span class="ticket-time">
            <i class="fa-regular fa-clock" aria-hidden="true"></i>
            ${safe(relativeTime(ticket.createdAt))}
          </span>
          ${ticket.assignedToName ? `
          <span class="ticket-assigned">
            <i class="fa-solid fa-user-check" aria-hidden="true"></i>
            ${safe(ticket.assignedToName)}
          </span>` : ""}
        </div>

        <div class="ticket-footer">
          <div class="ticket-footer-primary">
            ${!ticket.assignedTo ? `<button class="btn-status btn-andamento" onclick="assumirTicket('${ticket.id}')"><i class="fa-solid fa-hand-pointer"></i> Assumir</button>` : ""}
            <button class="btn-status btn-chat" onclick="abrirChat('${escapeAttr(ticket.userId)}')"><i class="fa-solid fa-reply"></i> Responder</button>
            ${ticket.status !== "em_andamento" ? `<button class="btn-status btn-andamento" onclick="mudarStatus('${ticket.id}', 'em_andamento')"><i class="fa-solid fa-spinner"></i> Em andamento</button>` : ""}
            ${ticket.status !== "resolvido"    ? `<button class="btn-status btn-resolvido" onclick="mudarStatus('${ticket.id}', 'resolvido')"><i class="fa-solid fa-check"></i> Resolvido</button>` : ""}
            <button class="btn-status btn-transfer" onclick="transferirTicket('${ticket.id}')"><i class="fa-solid fa-right-left"></i> Transferir</button>
          </div>
          ${ticket.status !== "cancelado" ? `
          <div class="ticket-footer-danger">
            <button class="btn-status btn-cancelado" onclick="mudarStatus('${ticket.id}', 'cancelado')"><i class="fa-solid fa-xmark"></i> Cancelar</button>
          </div>` : ""}
        </div>

      </div>
    `).join("");
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

async function _executarMudarStatus(id, status) {
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
}

function updateStats(stats, tickets = [], liveStats = null) {
  if (!stats) return;

  const total     = stats.total ?? 0;
  const resolvido = stats.resolvido ?? stats.resolvidos ?? 0;
  const cancelado = stats.cancelado ?? stats.cancelados ?? 0;

  // Cards de estado atual usam liveStats (sem filtro de data) para bater com as abas de Atendimentos
  const live      = liveStats || stats;
  const aberto    = live.aberto ?? live.abertos ?? 0;
  const andamento = live.em_andamento ?? 0;
  const fechados  = (live.resolvido ?? 0) + (live.cancelado ?? 0);

  setText("stat-total",    total);
  setText("stat-aberto",   aberto);    // Pendentes = aberto (todos, sem filtro de data)
  setText("stat-andamento",andamento); // Ativos    = em_andamento (todos)
  setText("stat-resolvido",resolvido);
  setText("stat-encerrados",fechados);  // Encerrados = resolvido + cancelado (todos)
  setText("stat-contatos", new Set((tickets || []).map(t => t.userId)).size);

  setText("op-aberto",    aberto);
  setText("op-andamento", andamento);
  setText("op-resolvido", resolvido);
  setText("op-cancelado", cancelado);

  renderExecutiveDashboard(tickets, { total, aberto, andamento, resolvido, cancelado });
}

function renderExecutiveDashboard(tickets = [], stats = {}) {
  const lista = Array.isArray(tickets) ? tickets : [];

  const hoje = new Date().toISOString().slice(0, 10);
  const ticketsHoje = lista.filter(ticket => {
    const data = ticket.createdAt || ticket.created_at;
    return data && String(data).slice(0, 10) === hoje;
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
        <span>${safe(ticket.customerName || "Cliente não informado")} • ${safe(ticket.sector || "geral")}</span>
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

function playAlertSound(type = "ticket") {
  try {
    // Sons hospedados localmente para evitar dependência de domínio externo.
    // Fallback para Web Audio API se os arquivos não existirem.
    const localSrc = type === "message" ? "/sounds/message.ogg" : "/sounds/ticket.ogg";
    const audio    = new Audio(localSrc);
    audio.volume   = 0.5;
    audio.play().catch(() => {
      // Fallback: gera beep simples via Web Audio API
      try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = type === "message" ? 880 : 660;
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } catch (_) {}
    });
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
