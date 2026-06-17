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
      "1 - Solicitar orçamento de peça ou serviço\n" +
      "0 - Voltar ao menu principal",

    PEDIR_NOME:     "📝 Para solicitar orçamento, informe seu *nome completo*:",
    PEDIR_VEICULO:  "🚗 Qual o *veículo*? _(marca, modelo e ano)_\n_Digite *pular* se não se aplicar._",
    PEDIR_ORCAMENTO: "🔧 Qual *peça ou serviço* você precisa?",

    ORCAMENTO_SOLICITADO: (ticket) => {
      const veiculoMatch = ticket.description?.match(/Veículo:\s*([^|]+)/);
      const pecaMatch    = ticket.description?.match(/Produto\/Serviço:\s*(.+)/);
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

  gestao: {
    PEDIR_NOME:   "📝 Para registrar sua solicitação, informe seu *nome completo*:",
    PEDIR_MOTIVO: "💬 Conta o que aconteceu ou como a nossa equipe pode te ajudar:",

    REGISTRADO: (ticket) =>
      `✅ *Solicitação registrada com sucesso!*\n\n` +
      `👤 Nome: ${ticket.customerName}\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `Um membro da gestão entrará em contato com você em breve.\n` +
      `Horário: Seg–Sex 07:50–17:50\n\n` +
      `Posso ajudar com mais alguma coisa? Digite *0* para o menu.`,
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
