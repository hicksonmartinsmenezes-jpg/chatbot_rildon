const { getSession, clearSession }                          = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");

const suporteFlow    = require("./suporte.flow");
const vendasFlow     = require("./vendas.flow");
const financeiroFlow = require("./financeiro.flow");

function menuPrincipal() {
  const horario = estaEmHorarioDeAtendimento();
  const status  = horario ? "🟢 Atendimento aberto" : "🔴 *Fora do horário de atendimento*";

  return ` 
${status}
Olá! Seja bem-vindo(a).

Como podemos ajudar você hoje?

1️ - Dúvidas frequentes
2️ - Nossos serviços
3️ - Horário de atendimento
4️ - Suporte técnico
5️ - Vendas / Orçamento
6️ - Financeiro
7️ - Falar com atendente

_Digite o número da opção desejada._`;
}

async function mainFlow({ userId, message }) {
  const session = getSession(userId);
  const msg     = message.trim().toLowerCase();

  if (msg === "0" || msg === "menu" || msg === "início" || msg === "inicio") {
    await clearSession(userId);
    return menuPrincipal();
  }

  if (session.sector === "suporte")    return suporteFlow(message, userId, session);
  if (session.sector === "vendas")     return vendasFlow(message, userId, session);
  if (session.sector === "financeiro") return financeiroFlow(message, userId, session);

  switch (message.trim()) {
    case "1":
      return `❓ *Dúvidas Frequentes*\n\n*Como funciona o atendimento?*\nNosso atendimento inicial é automatizado. Se necessário, encaminhamos para um humano.\n\n*Posso falar com uma pessoa?*\nSim! Digite 7 no menu principal.\n\n*Qual o horário de atendimento?*\nVeja a opção 3 do menu.\n\n*Vocês fazem entrega?*\nEntre em contato via opção 5 (Vendas) para consultar.\n\nDigite *0* para voltar ao menu.`;

    case "2":
      return `🛠️ *Nossos Serviços*\n\n• Venda de peças elétricas\n• Suporte e consultoria técnica\n• Orçamentos personalizados\n• Atendimento presencial e online\n\nDigite *0* para voltar ao menu.`;

    case "3":
      return `🕐 *Horário de Atendimento*\n\n📅 Segunda a sexta: 07:50 às 17:50\n📅 Sábado: 07:50 às 12:00\n🚫 Domingo: Fechado\n\n${estaEmHorarioDeAtendimento() ? "✅ Estamos abertos agora!" : "⏰ No momento estamos fechados."}\n\nDigite *0* para voltar ao menu.`;

    case "4": return suporteFlow(message, userId, session);
    case "5": return vendasFlow(message, userId, session);

    case "6": {
      const ticket = await createTicket({
        userId,
        type:        "duvida_financeira",
        description: "Cliente solicitou atendimento financeiro pelo menu principal.",
      });
      notificarAtendente(ticket);
      return `💰 *Financeiro*\n\n    Sua solicitação foi registrada!\n\n    🎫 Protocolo: *#${ticket.protocolo}*\n    🕐 Aguarde, um atendente do financeiro entrará em contato em breve.\n\n    Digite *0* para voltar ao menu.`;
    }

    case "7": {
      const ticket = await createTicket({
        userId,
        type:        "atendente_humano",
        description: "Cliente solicitou atendimento humano via menu principal.",
      });
      notificarAtendente(ticket);

      if (!estaEmHorarioDeAtendimento()) {
        return `${mensagemForaDeHorario()}\n\n🎫 Protocolo registrado: *#${ticket.protocolo}*`;
      }

      return `👤 *Atendimento Humano*\n\nSua solicitação foi registrada!\n\n🎫 Protocolo: *#${ticket.protocolo}*\n🕐 Aguarde, um atendente entrará em contato em breve.\n\nHorário: Seg–Sex 07:50–17:50 | Sáb 07:50–12:00\n\nDigite *0* para voltar ao menu.`;
    }

    default:
      return menuPrincipal();
  }
}

module.exports = mainFlow;
