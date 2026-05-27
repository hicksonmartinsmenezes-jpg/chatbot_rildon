const { updateSession, clearSession }                       = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto }                                    = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");

async function financeiroFlow(message, userId, session) {
  const msg = sanitizarTexto(message.trim());

  if (session.sector === "financeiro") {
    if (session.step === "aguardando_duvida") {
      const v = validarTamanho(msg, 5);
      if (!v.ok) {
        if (v.erro === "minimo") return "⚠️ Por favor, descreva melhor sua dúvida.";
        return mensagemTamanhoInvalido(5);
      }

      const ticket = await createTicket({ userId, type: "duvida_financeira", description: msg });
      notificarAtendente(ticket);
      await clearSession(userId);

      return `✅ *Dúvida registrada!*\n\n🎫 Protocolo: *#${ticket.protocolo}*\n📋 Dúvida: _${msg}_\n\nNossa equipe financeira irá responder em horário comercial.\nDigite *0* para voltar ao menu.`;
    }

    switch (msg) {
      case "1":
        await updateSession(userId, { step: "aguardando_duvida" });
        return "💬 Descreva sua *dúvida sobre pagamento* ou envie seu CPF/CNPJ para consulta:";

      case "2":
        return `💳 *Formas de Pagamento*\n\n• Dinheiro\n• PIX\n• Cartão de débito e crédito\n• Boleto bancário (consulte prazo)\n\nDúvidas? Use a opção 1.\nDigite *0* para voltar ao menu.`;

      case "3": {
        if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
        const ticket = await createTicket({
          userId,
          type:        "atendente_financeiro",
          description: "Cliente solicitou atendente do financeiro.",
        });
        notificarAtendente(ticket);
        await clearSession(userId);
        return `👤 Um atendente do financeiro entrará em contato!\n\n🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`;
      }

      default:
        return menuFinanceiro();
    }
  }

  await updateSession(userId, { sector: "financeiro" });
  return menuFinanceiro();
}

function menuFinanceiro() {
  return `💰 *Financeiro*\n\nComo posso ajudar?\n\n1️⃣ - Dúvidas sobre pagamento / consulta\n2️⃣ - Formas de pagamento aceitas\n3️⃣ - Falar com financeiro\n0️⃣ - Voltar ao menu principal`;
}

module.exports = financeiroFlow;
