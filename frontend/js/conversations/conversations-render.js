// conversations-render.js
// Helpers de renderização da tela de conversas.
// Mantém templates pequenos fora do arquivo principal, sem alterar o fluxo atual.

function buildConversationActionButtons(userId, ticket, humanModeSet = new Set()) {
  const user = escapeAttr(userId);
  let html = "";

  if (ticket && ticket.status === "aberto") {
    const ticketId = escapeAttr(ticket.id);
    html = `
      <button type="button" class="conv-action-btn conv-btn-aceitar" data-conv-action="aceitar" data-ticket-id="${ticketId}">
        <i class="fa-solid fa-check"></i> Aceitar
      </button>
      <button type="button" class="conv-action-btn conv-btn-transferir" data-conv-action="transferir" data-ticket-id="${ticketId}">
        <i class="fa-solid fa-right-left"></i> Transferir
      </button>
      <button type="button" class="conv-action-btn conv-btn-fechar" data-conv-action="fechar" data-ticket-id="${ticketId}">
        <i class="fa-solid fa-xmark"></i> Fechar
      </button>
    `;
  } else if (ticket && ticket.status === "em_andamento") {
    const ticketId = escapeAttr(ticket.id);
    html = `
      <button type="button" class="conv-action-btn conv-btn-transferir" data-conv-action="transferir" data-ticket-id="${ticketId}">
        <i class="fa-solid fa-right-left"></i> Transferir
      </button>
      <button type="button" class="conv-action-btn conv-btn-fechar" data-conv-action="fechar" data-ticket-id="${ticketId}">
        <i class="fa-solid fa-xmark"></i> Fechar
      </button>
    `;
  } else if (!ticket) {
    html = `
      <button type="button" class="conv-action-btn conv-btn-aceitar" data-conv-action="reabrir" data-user-id="${user}">
        <i class="fa-solid fa-plus"></i> Iniciar Atendimento
      </button>
    `;
  } else if (ticket.status === "resolvido" || ticket.status === "cancelado") {
    html = `
      <button type="button" class="conv-action-btn conv-btn-aceitar" data-conv-action="reabrir" data-user-id="${user}">
        <i class="fa-solid fa-rotate-left"></i> Reabrir
      </button>
    `;
  }

  if (humanModeSet.has(userId)) {
    html += `
      <button type="button" class="conv-action-btn conv-btn-refresh" data-conv-action="release-bot" data-user-id="${user}" title="Reativar o bot para este cliente">
        <i class="fa-solid fa-robot"></i> Devolver ao bot
      </button>`;
  }

  return html;
}
