const { getSession, clearSession }                           = require("../services/session.service");
const { createTicket }                                       = require("../services/ticket.service");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario }  = require("../utils/horario");
const { notificarAtendente, notificarSeDisponivel }          = require("../services/notificacao.service");
// CORRIGIDO: normalizar() vem de validators (fonte única de verdade)
const { normalizar }                                         = require("../utils/validators");
const MSG                                                    = require("./messages");

const suporteFlow    = require("./suporte.flow");
const vendasFlow     = require("./vendas.flow");
const financeiroFlow = require("./financeiro.flow");

// Palavras que resetam a sessão e voltam ao menu principal
const PALAVRAS_MENU = new Set([
  "0", "menu", "inicio", "voltar", "home",
  "oi", "ola", "opa", "bom dia", "boa tarde", "boa noite",
]);

function menuPrincipal() {
  const aberto = estaEmHorarioDeAtendimento();
  const status  = aberto ? "🟢 Atendimento aberto" : "🔴 *Fora do horário de atendimento*";
  return (
    `${status}\n` +
    "Olá! Seja bem-vindo(a).\n\n" +
    "Como podemos ajudar você hoje?\n\n" +
    "1️ - Dúvidas frequentes\n" +
    "2️ - Nossos serviços\n" +
    "3️ - Horário de atendimento\n" +
    "4️ - Suporte técnico\n" +
    "5️ - Vendas / Orçamento\n" +
    "6️ - Financeiro\n" +
    "7️ - Falar com atendente\n\n" +
    "_Digite o número da opção desejada._"
  );
}

async function mainFlow({ userId, message }) {
  const session = getSession(userId);
  const msgNorm = normalizar(message);

  if (PALAVRAS_MENU.has(msgNorm)) {
    clearSession(userId);
    return menuPrincipal();
  }

  if (session.sector === "suporte")    return suporteFlow(message, userId, session);
  if (session.sector === "vendas")     return vendasFlow(message, userId, session);
  if (session.sector === "financeiro") return financeiroFlow(message, userId, session);

  switch (msgNorm) {
    case "1":
      return (
        "❓ *Dúvidas Frequentes*\n\n" +
        "*Como funciona o atendimento?*\n" +
        "Nosso atendimento inicial é automatizado. Se necessário, encaminhamos para um humano.\n\n" +
        "*Posso falar com uma pessoa?*\n" +
        "Sim! Digite 7 no menu principal.\n\n" +
        "*Qual o horário de atendimento?*\n" +
        "Veja a opção 3 do menu.\n\n" +
        "*Vocês fazem entrega?*\n" +
        "Entre em contato via opção 5 (Vendas) para consultar.\n\n" +
        MSG.VOLTAR_MENU
      );

    case "2":
      return (
        "🛠️ *Nossos Serviços*\n\n" +
        "• Venda de peças elétricas\n" +
        "• Suporte e consultoria técnica\n" +
        "• Orçamentos personalizados\n" +
        "• Atendimento presencial e online\n\n" +
        MSG.VOLTAR_MENU
      );

    case "3":
      return (
        "🕐 *Horário de Atendimento*\n\n" +
        "🗓️ Segunda a sexta: *07:50h* às *17:50h*\n\n" +
        "🗓️ Sábado: *07:50h* às *12:00h*\n\n" +
        "🚫 Domingo: Fechado\n\n" +
        `${estaEmHorarioDeAtendimento() ? "⚡ Estamos abertos agora!" : "⏰ No momento estamos fechados."}\n\n` +
        MSG.VOLTAR_MENU
      );

    case "4": return suporteFlow(message, userId, session);
    case "5": return vendasFlow(message, userId, session);
    case "6": return financeiroFlow(message, userId, session);

    case "7": {
      const ticket = await createTicket({
        userId,
        type:         "atendente_humano",
        sector:       "atendimento",
        customerName: session.nome || MSG.NAO_INFORMADO,
        description:  "Cliente solicitou atendimento humano",
      });

      if (estaEmHorarioDeAtendimento()) {
        notificarAtendente(ticket);
        return MSG.main.ATENDENTE_HUMANO(ticket);
      }

      notificarSeDisponivel(ticket);
      return `${mensagemForaDeHorario()}\n\n🎫 Protocolo registrado: *#${ticket.protocolo}*`;
    }

    default:
      return menuPrincipal();
  }
}

module.exports = mainFlow;
