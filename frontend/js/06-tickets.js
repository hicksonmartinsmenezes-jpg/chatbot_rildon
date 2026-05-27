// 06-tickets.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Tickets ──────────────────────────────────────────────────────────────────
async function loadTickets() {
  const search    = document.getElementById("search")?.value || "";
  const status    = document.getElementById("filter-status")?.value || "";
  const container = document.getElementById("tickets-container");

  if (container) container.innerHTML = `<p class="loading">Carregando atendimentos...</p>`;

  try {
    const params = new URLSearchParams();
    if (search) params.append("search", search);
    if (status) params.append("status", status);

    const res = await apiFetch(`${BASE}/api/tickets?${params}`);
    if (!res) return;
    const data = await res.json();

    updateStats(data.stats, data.tickets || []);

    if (!firstLoadTickets && data.total > lastTicketTotal) showNewTicketAlert();

    lastTicketTotal  = data.total;
    firstLoadTickets = false;

    if (!container) return;

    if (!data.tickets?.length) {
      container.innerHTML = `<p class="empty">Nenhum atendimento encontrado.</p>`;
      return;
    }

    container.innerHTML = data.tickets.map(ticket => `
      <div class="ticket-card ${ticket.status} ${ticket.status === "aberto" ? "novo-ticket" : ""}" id="card-${ticket.id}">
        <div class="ticket-header">
          <span class="ticket-id">#${ticket.protocolo || ticket.id} — ${tipoLabel(ticket.type)}</span>
          <span class="status-badge status-${ticket.status}">${statusLabel(ticket.status)}</span>
        </div>
        <p><strong>👤 Cliente:</strong> ${safe(ticket.customerName || "Não informado")}</p>
        <p><strong>🪪 CPF:</strong> ${safe(ticket.cpf || "Não informado")}</p>
        <p><strong>📱 Número:</strong> ${formatPhone(ticket.userId)}</p>
        <p class="desc"><strong>📋 Descrição:</strong><br>${safe(ticket.description || "—")}</p>
        <p><strong>🕐 Criado em:</strong> ${formatDate(ticket.createdAt)}</p>
        ${ticket.assignedToName ? `<p><strong>👨‍💼 Responsável:</strong> ${safe(ticket.assignedToName)}</p>` : ""}
        <div class="ticket-footer">
          ${!ticket.assignedTo ? `<button class="btn-status btn-andamento" onclick="assumirTicket('${ticket.id}')">Assumir</button>` : ""}
          <button class="btn-status btn-chat" onclick="abrirChat('${escapeAttr(ticket.userId)}')">Responder</button>
          ${ticket.status !== "em_andamento" ? `<button class="btn-status btn-andamento" onclick="mudarStatus('${ticket.id}', 'em_andamento')">Em andamento</button>` : ""}
          ${ticket.status !== "resolvido"    ? `<button class="btn-status btn-resolvido" onclick="mudarStatus('${ticket.id}', 'resolvido')">Resolvido</button>` : ""}
          ${ticket.status !== "cancelado"    ? `<button class="btn-status btn-cancelado" onclick="mudarStatus('${ticket.id}', 'cancelado')">Cancelar</button>` : ""}
          <button class="btn-status" onclick="transferirTicket('${ticket.id}')">Transferir</button>
        </div>
      </div>
    `).join("");
  } catch (err) {
    if (container) container.innerHTML = `<p class="empty">❌ Erro ao carregar atendimentos.</p>`;
  }
}

async function mudarStatus(id, status) {
  try {
    await apiFetch(`${BASE}/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
   loadTickets();

if (currentTab === "metrics") {
  loadMetricsCharts();
}
  } catch {
    showToast("Não foi possível atualizar o ticket.");
  }
}

function updateStats(stats, tickets = []) {
  if (!stats) return;
  const total     = stats.total ?? 0;
  const aberto    = stats.aberto ?? stats.abertos ?? 0;
  const andamento = stats.em_andamento ?? 0;
  const resolvido = stats.resolvido ?? stats.resolvidos ?? 0;

  setText("stat-total",    total);
  setText("stat-aberto",   aberto);
  setText("stat-andamento", andamento);
  setText("stat-resolvido", resolvido);
  setText("stat-pendentes", aberto + andamento);
  setText("stat-contatos",  new Set((tickets || []).map(t => t.userId)).size);
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
    const src = type === "message"
      ? "https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg"
      : "https://actions.google.com/sounds/v1/alarms/beep_short.ogg";
    const audio = new Audio(src);
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch (_) {}
}

function showNewTicketAlert() {
  document.querySelector(".notification")?.classList.add("has-alert");
  playAlertSound("ticket");
  showToast("🎫 Novo atendimento recebido!");
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
      if (currentTab === "metrics") {
  loadMetricsCharts();
}
    }
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function transferirTicket(id) {
  const sector = prompt("Transferir para qual setor?\n\nvendas\nfinanceiro\nsuporte\ngarantia");
  if (!sector) return;

  try {
    const res = await apiFetch(`${BASE}/api/tickets/${id}/transfer`, {
      method: "PATCH",
      body: JSON.stringify({ sector })
    });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao transferir ticket.");
    showToast("✅ Ticket transferido!");
    loadTickets();
    if (currentTab === "metrics") {
  loadMetricsCharts();
}
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// ─── Gráficos ─────────────────────────────────────────────────────────────────
async function loadDashboardCharts() {
  if (typeof Chart === "undefined") return;

  const user = getCurrentUser();
  if (!["admin", "supervisor"].includes(user?.perfil)) return;

  try {
    const res = await apiFetch(`${BASE}/api/tickets/dashboard`);
    if (!res) return;
    const data = await res.json();

    const statusCanvas = document.getElementById("chart-status");
    const sectorCanvas = document.getElementById("chart-sector");
    if (!statusCanvas || !sectorCanvas) return;

    if (chartStatus) chartStatus.destroy();
    if (chartSector) chartSector.destroy();

    chartStatus = new Chart(statusCanvas, {
      type: "doughnut",
      data: {
        labels: Object.keys(data.porStatus || {}),
        datasets: [{ data: Object.values(data.porStatus || {}) }]
      }
    });

    chartSector = new Chart(sectorCanvas, {
      type: "bar",
      data: {
        labels: Object.keys(data.porSetor || {}),
        datasets: [{ label: "Atendimentos", data: Object.values(data.porSetor || {}) }]
      }
    });
  } catch (_) {}
}
