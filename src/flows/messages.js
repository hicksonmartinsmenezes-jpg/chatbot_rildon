// messages.js — Centralização de todas as mensagens do chatbot

const MSG = {
  VOLTAR_MENU:     "\n_Digite *0* para voltar ao menu._",
  NAO_INFORMADO:   "Não informado",
  CPF_INVALIDO:    "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).",
  NOME_INVALIDO:   "⚠️ Por favor, informe seu nome. _Ex: João Silva ou Marcos_",
  DESCRICAO_CURTA: (min) => `⚠️ Por favor, descreva com mais detalhes (mínimo ${min} caracteres).`,
  ESCAPE_DICA:     "\n_Digite *0* a qualquer momento para voltar ao menu._",

  vendas: {
    MENU: () =>
      "🛒 *Orçamento / Atendimento*\n\n" +
      "Como posso te ajudar?\n\n" +
      "1 - Solicitar orçamento de peça\n" +
      "0 - Voltar ao menu principal",

    PEDIR_NOME:     "📝 Para solicitar orçamento, informe seu *nome completo*:",
    PEDIR_VEICULO:  "🚗 Qual o *veículo*? _(marca, modelo e ano)_\n_Digite *pular* se não se aplicar._",
    PEDIR_ORCAMENTO: "🔧 Qual *peça* você precisa?",

    // Pedido do usuário: quando o cliente só faz uma pergunta de
    // disponibilidade ("tem X pra Y?"), em vez de despejar o menu
    // completo (1-4), pergunta direto se ele quer o orçamento — mais
    // natural que forçar o cliente a escolher "1" de novo depois de já
    // ter perguntado sobre a peça.
    CONFIRMAR_ORCAMENTO: "Deseja que eu já registre esse orçamento? Digite *sim* para confirmar ou *0* para voltar ao menu.",

    ORCAMENTO_SOLICITADO: (ticket) => {
      const veiculoMatch = ticket.description?.match(/Veículo:\s*([^|]+)/);
      const pecaMatch    = ticket.description?.match(/Produto:\s*(.+)/);
      const veiculo      = veiculoMatch ? veiculoMatch[1].trim() : null;
      const peca         = pecaMatch    ? pecaMatch[1].trim()    : ticket.description;

      return (
        `✅ *Orçamento registrado!*\n\n` +
        `👤 ${ticket.customerName} — 🎫 *#${ticket.protocolo}*\n` +
        (veiculo ? `🚗 ${veiculo}\n` : "") +
        `🔧 ${peca}\n\n` +
        `Em breve nosso consultor entrará em contato. _Digite *0* para o menu._`
      );
    },

    CONSULTOR: (ticket) =>
      `👤 Um atendente entrará em contato em breve!\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `_Digite *0* para o menu._`,
  },

  crediario: {
    MENU: () =>
      "💳 *Crediário*\n\n" +
      "Oferecemos crediário próprio para nossos clientes!\n\n" +
      "1 - Solicitar crediário\n" +
      "2 - Consultar situação do meu crediário\n" +
      "0 - Voltar ao menu principal",

    PEDIR_NOME:  "📝 Para continuar, informe seu *nome completo*:",
    PEDIR_CPF:   "🪪 Informe seu *CPF* (somente números):",
    PEDIR_MOTIVO: "💬 Descreva o que deseja comprar ou contratar pelo crediário:",

    SOLICITACAO_REGISTRADA: (ticket) =>
      `✅ *Solicitação de crediário registrada!*\n\n` +
      `👤 Nome: ${ticket.customerName}\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `Nossa equipe entrará em contato para dar continuidade.\n` +
      `Horário: Seg–Sex 07:50–17:50 | Sáb 08:00–12:00\n\n` +
      `Posso ajudar com mais alguma coisa? Digite *0* para o menu ou continue conversando.`,

    ATENDENTE: (ticket) =>
      `👤 Um atendente entrará em contato em breve!\n\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `Posso ajudar com mais alguma coisa? Digite *0* para o menu.`,
  },

  // Pedido do usuário (2026-07-21): o antigo fluxo "gestao" (opção 3 do menu,
  // "Falar com a Equipe") pedia nome + motivo e criava um ticket pra alguém
  // da gestão responder depois. Decisão deliberada de substituir por uma
  // lista estática de contatos diretos — o cliente liga direto pro setor
  // certo, sem passar pelo bot/ticket. Não é mais um fluxo com etapas, só
  // uma mensagem informativa.
  outrosContatos: {
    LISTA: () =>
      "📞 *Outros Contatos*\n\n" +
      "Fale direto com o setor responsável:\n\n" +
      "🧑‍💼 Recursos Humanos / DP: (79) 9152-0145\n" +
      "💳 Crediário: (79) 9135-2723\n" +
      "🛠️ Garantia: (79) 9199-1922\n" +
      "📢 Ouvidoria: (79) 9180-0035\n\n" +
      "_Digite *0* para voltar ao menu._",
  },

  main: {
    PEDIR_MOTIVO_ATENDENTE:
      "💬 Certo! Para agilizar seu atendimento, descreva brevemente o que precisa:\n" +
      "_Ex: Quero orçamento de alternador, Dúvida sobre crediário..._\n\n" +
      "_Digite *0* para voltar ao menu._",

    ATENDENTE_HUMANO: (ticket) =>
      "👤 *Falar com Atendente*\n\n" +
      "Sua solicitação foi registrada!\n\n" +
      `🎫 Protocolo: *#${ticket.protocolo}*\n` +
      "🕐 Um atendente entrará em contato em breve.\n\n" +
      "Horário: Seg–Sex 07:50–17:50 | Sáb 08:00–12:00\n\n" +
      "Posso ajudar com mais alguma coisa? Digite *0* para o menu.",
  },
};

module.exports = MSG;
