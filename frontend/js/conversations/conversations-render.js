// conversations-render.js
// Helpers de renderização da tela de conversas.
// Mantém templates pequenos fora do arquivo principal, sem alterar o fluxo atual.

function buildConversationActionButtons(userId, ticket, humanModeSet = new Set(), ctx = {}) {
  const user = escapeAttr(userId);
  const { currentUserId = null, fullAccess = true } = ctx;

  // BUG CORRIGIDO: quando outro atendente assume/transfere/fecha um ticket
  // que eu já estava com a conversa aberta na tela, os botões de ação
  // (Transferir/Fechar/Devolver ao bot) continuavam aparecendo como se
  // fossem meus — o backend já bloqueava certo (403), mas a UI só avisava
  // DEPOIS de clicar. Em modo restrito, se o ticket pertence a OUTRO
  // atendente, mostra só um aviso e nenhum botão de ação.
  //
  // BUG CORRIGIDO (2): esse trava valia pra QUALQUER status, mas fechar()
  // não limpa assigned_to (só reabrir/status=aberto limpa — ver
  // ticket.repository.js). Então um ticket "resolvido" continua com
  // assigned_to apontando pra quem o fechou por último, e outro atendente
  // via a conversa travada ("sem ações disponíveis") mesmo já podendo
  // reabrir/fechar de novo (canManageTicket libera aberto/resolvido/
  // cancelado pra qualquer atendente — só em_andamento é exclusivo de
  // quem assumiu). Reportado pelo usuário: "não consigo reabrir nem
  // fechar". Agora só trava quando o ticket está ATIVO (em_andamento) com
  // outro dono — pendente e fechado nunca travam.
  const pertenceAOutro = Boolean(
    ticket?.status === "em_andamento" &&
    ticket?.assignedTo && currentUserId && String(ticket.assignedTo) !== String(currentUserId)
  );
  if (!fullAccess && pertenceAOutro) {
    const nome = escapeAttr(ticket.assignedToName || "outro atendente");
    return `<span class="chat-locked-note"><i class="fa-solid fa-lock"></i> Assumido por ${nome} — sem ações disponíveis aqui</span>`;
  }

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

  return html;
}
