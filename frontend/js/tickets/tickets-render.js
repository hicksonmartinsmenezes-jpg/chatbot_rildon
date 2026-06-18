// tickets-render.js
// Renderização e delegação de eventos da tela de atendimentos.
// Mantém o 06-tickets.js mais focado em fluxo/API.

function renderTicketCard(ticket) {
  const ticketStatus = normalizeId(ticket.status);
  const ticketId = escapeAttr(String(ticket.id));
  const ticketUserId = escapeAttr(ticket.userId);

  return `
    <div class="ticket-card ${ticketStatus} ${ticket.status === "aberto" ? "novo-ticket" : ""}" id="card-${ticketId}">
      <div class="ticket-header">
        <div class="ticket-header-left">
          <span class="ticket-id">#${safe(ticket.protocolo || ticket.id)}</span>
          <span class="ticket-type-badge">${safe(tipoLabel(ticket.type))}</span>
        </div>
        <span class="status-badge status-${ticketStatus}">${safe(statusLabel(ticket.status))}</span>
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
          ${!ticket.assignedTo ? `<button class="btn-status btn-andamento" type="button" data-ticket-action="assumir" data-ticket-id="${ticketId}"><i class="fa-solid fa-hand-pointer"></i> Assumir</button>` : ""}
          <button class="btn-status btn-chat" type="button" data-ticket-action="abrir-chat" data-user-id="${ticketUserId}"><i class="fa-solid fa-reply"></i> Responder</button>
          ${ticket.status !== "em_andamento" ? `<button class="btn-status btn-andamento" type="button" data-ticket-action="status" data-ticket-id="${ticketId}" data-status="em_andamento"><i class="fa-solid fa-spinner"></i> Em andamento</button>` : ""}
          ${ticket.status !== "resolvido" ? `<button class="btn-status btn-resolvido" type="button" data-ticket-action="status" data-ticket-id="${ticketId}" data-status="resolvido"><i class="fa-solid fa-check"></i> Resolvido</button>` : ""}
          <button class="btn-status btn-transfer" type="button" data-ticket-action="transferir" data-ticket-id="${ticketId}"><i class="fa-solid fa-right-left"></i> Transferir</button>
        </div>
        ${ticket.status !== "cancelado" ? `
        <div class="ticket-footer-danger">
          <button class="btn-status btn-cancelado" type="button" data-ticket-action="status" data-ticket-id="${ticketId}" data-status="cancelado"><i class="fa-solid fa-xmark"></i> Cancelar</button>
        </div>` : ""}
      </div>
    </div>
  `;
}

function bindTicketActionDelegation() {
  const container = document.getElementById("tickets-container");
  if (!container || container.dataset.delegated === "true") return;
  container.dataset.delegated = "true";

  container.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-ticket-action]");
    if (!btn || !container.contains(btn)) return;

    const action = btn.dataset.ticketAction;
    const id = btn.dataset.ticketId;
    const userId = btn.dataset.userId;

    if (action === "assumir" && id) return assumirTicket(id);
    if (action === "abrir-chat" && userId) return abrirChat(userId);
    if (action === "transferir" && id) return transferirTicket(id);
    if (action === "status" && id && btn.dataset.status) return mudarStatus(id, btn.dataset.status);
  });
}
