// messages.js — Centralização de todas as mensagens do chatbot
// Facilita manutenção e futura internacionalização

const MSG = {
  VOLTAR_MENU:       "Digite *0* para voltar ao menu.",
  NAO_INFORMADO:     "Não informado",
  CPF_INVALIDO:      "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).",
  NOME_INVALIDO:     "⚠️ Por favor, informe seu *nome completo* (nome e sobrenome).",
  DESCRICAO_CURTA:   (min) => `⚠️ Por favor, descreva com mais detalhes (mínimo ${min} caracteres).`,

  suporte: {
    MENU: () =>
      "🔧 *Suporte Técnico*\n\nComo posso ajudar?\n\n" +
      "1️ - Abrir chamado técnico\n" +
      "2️ - Consultar chamado por CPF\n" +
      "3️ - Falar com técnico humano\n" +
      "0️ - Voltar ao menu principal",

    PEDIR_PROBLEMA:   "🔧 Descreva o *problema técnico* que você está enfrentando:",
    PEDIR_NOME:       "📝 Entendido! Agora informe seu *nome completo* (nome e sobrenome).",
    PEDIR_CPF:        "🪪 Informe seu *CPF* (somente números).",
    PEDIR_CPF_CONSULTA: "🔍 Informe seu *CPF* para consultar seus atendimentos:",
    NENHUM_CHAMADO:   "🔍 Nenhum chamado encontrado para o CPF informado.\n\nDigite *0* para voltar ao menu.",

    CHAMADO_ABERTO: (ticket) =>
      `✅ *Chamado aberto com sucesso!*\n\n` +
      `👤 Nome: ${ticket.customerName}\n` +
      `🪪 CPF: ${ticket.cpf}\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\n` +
      `📋 Problema relatado:\n_${ticket.description}_\n\n` +
      `Nossa equipe irá analisar e retornar em breve.\n` +
      `Digite *0* para voltar ao menu.`,

    CONSULTA_RESULTADO: (tickets) => {
      const total = tickets.length;
      const lista = tickets
        .slice(-5)
        .map(t =>
          `• *#${t.protocolo}* — ${t.type} — _${t.status}_\n` +
          `  📅 ${new Date(t.createdAt).toLocaleDateString("pt-BR")}`
        )
        .join("\n\n");
      return (
        `🔍 *Chamados encontrados:* ${total > 5 ? `exibindo os últimos 5 de ${total}` : total}\n\n` +
        `${lista}\n\nDigite *0* para voltar ao menu.`
      );
    },

    TECNICO_HUMANO: (ticket) =>
      `👤 Você será atendido por um técnico em breve.\n\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`,
  },

  vendas: {
    MENU: () =>
      "🛒 *Vendas / Orçamento*\n\nComo posso ajudar?\n\n" +
      "1️ - Solicitar orçamento\n" +
      "2️ - Ver produtos e serviços\n" +
      "3️ - Falar com consultor\n" +
      "0️ - Voltar ao menu principal",

    PEDIR_NOME:      "📝 Para solicitar orçamento, informe seu *nome completo*:",
    PEDIR_ORCAMENTO: "💬 Descreva o *produto ou serviço* que você precisa de orçamento:",

    PRODUTOS:
      "🛍️ *Nossos Produtos e Serviços*\n\n" +
      "• Peças elétricas em geral\n" +
      "• Motores e componentes\n" +
      "• Materiais elétricos industriais\n" +
      "• Ferramentas e equipamentos\n" +
      "• Consultoria técnica especializada\n\n" +
      "Precisa de algo específico? Escolha a opção 1 para orçamento.\n" +
      "Digite *0* para voltar ao menu.",

    ORCAMENTO_SOLICITADO: (ticket) =>
      `✅ *Orçamento solicitado!*\n\n` +
      `👤 Nome: ${ticket.customerName}\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n` +
      `📋 Solicitação: _${ticket.description}_\n\n` +
      `Um consultor entrará em contato para te atender.\n` +
      `Digite *0* para voltar ao menu.`,

    CONSULTOR: (ticket) =>
      `👤 Um consultor de vendas entrará em contato!\n\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`,
  },

  financeiro: {
    MENU: () =>
      "💰 *Financeiro*\n\nComo posso ajudar?\n\n" +
      "1️ - Dúvidas sobre pagamento / consulta\n" +
      "2️ - Formas de pagamento aceitas\n" +
      "3️ - Falar com financeiro\n" +
      "0️ - Voltar ao menu principal",

    PEDIR_NOME:  "📝 Para continuar, informe seu *nome completo*:",
    PEDIR_DUVIDA:
      "💬 Descreva sua *dúvida financeira*\n" +
      "ou envie CPF/CNPJ para consulta:",

    FORMAS_PAGAMENTO:
      "💳 *Formas de Pagamento*\n\n" +
      "• Dinheiro\n• PIX\n• Cartão de débito e crédito\n" +
      "• Boleto bancário (consulte prazo)\n\n" +
      "Dúvidas? Use a opção 1.\n" +
      "Digite *0* para voltar ao menu.",

    DUVIDA_REGISTRADA: (ticket, documento, msg) =>
      `✅ *Dúvida registrada!*\n\n` +
      `👤 Nome: ${ticket.customerName}\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n` +
      (documento
        ? `🪪 Documento: _${documento}_\n📋 Solicitação: _Consulta financeira_\n`
        : `📋 Dúvida: _${msg}_\n`) +
      `\nNossa equipe financeira irá responder em horário comercial.\n` +
      `Digite *0* para voltar ao menu.`,

    ATENDENTE: (ticket) =>
      `👤 Um atendente do financeiro entrará em contato!\n\n` +
      `🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`,

    DOCUMENTO_INVALIDO:
      "⚠️ Documento inválido. Por favor, informe um *CPF* (11 dígitos) ou *CNPJ* (14 dígitos) válido.",
  },

  main: {
    ATENDENTE_HUMANO: (ticket) =>
      "👤 *Atendimento Humano*\n\n" +
      "Sua solicitação foi registrada!\n\n" +
      `🎫 Protocolo: *#${ticket.protocolo}*\n` +
      "🕐 Aguarde, um atendente entrará em contato em breve.\n\n" +
      "Horário: Seg–Sex 07:50–17:50 | Sáb 07:50–12:00\n\n" +
      "Digite *0* para voltar ao menu.",
  },
};

module.exports = MSG;
