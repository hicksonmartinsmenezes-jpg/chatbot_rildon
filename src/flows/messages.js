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
      "🛒 *Orçamento / Falar com atendente*\n\n" +
      "Vou te ajudar a solicitar um orçamento e um atendente entrará em contato! 😊",

    PEDIR_NOME:     "📝 Para solicitar orçamento, informe seu *nome completo*:",
    PEDIR_VEICULO:  "🚗 Informe o *veículo* (marca, modelo e ano):\n_Ex: VW Gol G5 2012 ou Fiat Uno 2015_\n\n_Digite *pular* se não souber ou não se aplicar._",
    PEDIR_ORCAMENTO:
      "💬 Descreva o *produto ou peça* que precisa:\n" +
      "_Ex: alternador, sensor MAP, lâmpada H4 farol, fusível caixa..._\n\n" +
      "Quanto mais detalhes, mais rápido o consultor te responde! 😊",

    ORCAMENTO_SOLICITADO: (ticket) => {
      // Extrai veículo e peça do description interno "Veículo: X | Produto/Serviço: Y"
      const veiculoMatch = ticket.description?.match(/Veículo:\s*([^|]+)/);
      const pecaMatch    = ticket.description?.match(/Produto\/Serviço:\s*(.+)/);
      const veiculo      = veiculoMatch ? veiculoMatch[1].trim() : null;
      const peca         = pecaMatch    ? pecaMatch[1].trim()    : ticket.description;

      return (
        `✅ *Orçamento solicitado com sucesso!*\n\n` +
        `👤 *${ticket.customerName}*\n` +
        `🎫 Protocolo: *#${ticket.protocolo}*\n` +
        (veiculo ? `🚗 Veículo: ${veiculo}\n` : "") +
        `🔧 Peça/Serviço: ${peca}\n\n` +
        `Nosso consultor vai analisar e entrar em contato em breve! 😊\n` +
        `_Prazo médio: até 2h no horário comercial._\n\n` +
        `Posso te ajudar com mais alguma coisa? Digite *0* para o menu.`
      );
    },

    CONSULTOR: (ticket) =>
      `👤 Um atendente entrará em contato em breve!\n\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `Posso ajudar com mais alguma coisa? Digite *0* para o menu.`,
  },

  crediario: {
    MENU: () =>
      "💳 *Crediário*\n\n" +
      "Oferecemos crediário próprio para nossos clientes!\n\n" +
      "1 - Solicitar crediário\n" +
      "2 - Consultar situação do meu crediário\n" +
      "3 - Falar com o financeiro\n" +
      "0 - Voltar ao menu principal",

    PEDIR_NOME:  "📝 Para continuar, informe seu *nome completo*:",
    PEDIR_CPF:   "🪪 Informe seu *CPF* (somente números):",
    PEDIR_MOTIVO:
      "💬 Descreva brevemente o que deseja comprar no crediário\n" +
      "ou o motivo da consulta:",

    SOLICITACAO_REGISTRADA: (ticket) =>
      `✅ *Solicitação de crediário registrada!*\n\n` +
      `👤 Nome: ${ticket.customerName}\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `Nossa equipe financeira entrará em contato para dar continuidade.\n` +
      `Horário: Seg–Sex 07:50–17:50 | Sáb 08:00–12:00\n\n` +
      `Posso ajudar com mais alguma coisa? Digite *0* para o menu ou continue conversando.`,

    ATENDENTE: (ticket) =>
      `👤 Um atendente do financeiro entrará em contato!\n\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `Posso ajudar com mais alguma coisa? Digite *0* para o menu.`,
  },

  gestao: {
    PEDIR_NOME:   "📝 Para registrar sua solicitação, informe seu *nome completo*:",
    PEDIR_MOTIVO: "💬 Descreva o motivo pelo qual deseja falar com a gestão:",

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
