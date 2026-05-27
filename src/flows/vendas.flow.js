const { updateSession, clearSession }                       = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto }                                    = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");

async function vendasFlow(message, userId, session) {
  const msg = sanitizarTexto(message.trim());

  if (session.sector === "vendas") {
    if (session.step === "aguardando_orcamento") {
      const v = validarTamanho(msg, 5);
      if (!v.ok) {
        if (v.erro === "minimo") return "⚠️ Por favor, descreva melhor o produto ou serviço que precisa.";
        return mensagemTamanhoInvalido(5);
      }

      const ticket = await createTicket({ userId, type: "orcamento", description: msg });
      notificarAtendente(ticket);
      await clearSession(userId);

      return `✅ *Orçamento solicitado!*\n\n🎫 Protocolo: *#${ticket.protocolo}*\n📋 Solicitação: _${msg}_\n\nUm consultor entrará em contato para te atender.\nDigite *0* para voltar ao menu.`;
    }

    switch (msg) {
      case "1":
        await updateSession(userId, { step: "aguardando_orcamento" });
        return "💬 Descreva o *produto ou serviço* que você precisa de orçamento:";

      case "2":
        return `🛍️ *Nossos Produtos e Serviços*\n\n• Peças elétricas em geral\n• Motores e componentes\n• Materiais elétricos industriais\n• Ferramentas e equipamentos\n• Consultoria técnica especializada\n\nPrecisa de algo específico? Escolha a opção 1 para orçamento.\nDigite *0* para voltar ao menu.`;

      case "3": {
        if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
        const ticket = await createTicket({
          userId,
          type:        "consultor_vendas",
          description: "Cliente solicitou falar com consultor de vendas.",
        });
        notificarAtendente(ticket);
        await clearSession(userId);
        return `👤 Um consultor de vendas entrará em contato!\n\n🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`;
      }

      default:
        return menuVendas();
    }
  }

  await updateSession(userId, { sector: "vendas" });
  return menuVendas();
}

function menuVendas() {
  return `🛒 *Vendas / Orçamento*\n\nComo posso ajudar?\n\n1️⃣ - Solicitar orçamento\n2️⃣ - Ver produtos e serviços\n3️⃣ - Falar com consultor\n0️⃣ - Voltar ao menu principal`;
}

module.exports = vendasFlow;
