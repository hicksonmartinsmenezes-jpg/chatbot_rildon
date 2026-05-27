const { getSession, clearSession }                           = require("../services/session.service");
const { createTicket }                                       = require("../services/ticket.service");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario }  = require("../utils/horario");
const { notificarAtendente }                                 = require("../services/notificacao.service");

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
    const msg = message.trim().toLowerCase();

    if (msg === "0" || msg === "menu" || msg === "início" || msg === "inicio") {
        clearSession(userId);
        return menuPrincipal();
    }

    if (session.sector === "suporte")    return suporteFlow(message, userId, session);
    if (session.sector === "vendas")     return vendasFlow(message, userId, session);
    if (session.sector === "financeiro") return financeiroFlow(message, userId, session);

    switch (message.trim()) {
        case "1":
            return `❓ *Dúvidas Frequentes*

*Como funciona o atendimento?*
Nosso atendimento inicial é automatizado. Se necessário, encaminhamos para um humano.

*Posso falar com uma pessoa?*
Sim! Digite 7 no menu principal.

*Qual o horário de atendimento?*
Veja a opção 3 do menu.

*Vocês fazem entrega?*
Entre em contato via opção 5 (Vendas) para consultar.

Digite *0* para voltar ao menu.`;

        case "2":
            return `🛠️ *Nossos Serviços*

• Venda de peças elétricas
• Suporte e consultoria técnica
• Orçamentos personalizados
• Atendimento presencial e online

Digite *0* para voltar ao menu.`;

        case "3":
            return `🕐 *Horário de Atendimento*

📅 Segunda a sexta: 07:50 às 17:50
📅 Sábado: 07:50 às 12:00
🚫 Domingo: Fechado

${estaEmHorarioDeAtendimento() ? "✅ Estamos abertos agora!" : "⏰ No momento estamos fechados."}

Digite *0* para voltar ao menu.`;

        case "4": return suporteFlow(message, userId, session);
        case "5": return vendasFlow(message, userId, session);
       case "6": {
    const ticket = await createTicket({
        userId,
        type: "duvida_financeira",
        description: "Cliente solicitou atendimento financeiro pelo menu principal."
    });

    notificarAtendente(ticket);

    return `💰 *Financeiro*

    Sua solicitação foi registrada!

    🎫 Protocolo: *#${ticket.protocolo}*
    🕐 Aguarde, um atendente do financeiro entrará em contato em breve.

    Digite *0* para voltar ao menu.`;
    }

        case "7": {
            const ticket = await createTicket({
                userId,
                type: "atendente_humano",
                description: "Cliente solicitou atendimento humano via menu principal."
            });
            notificarAtendente(ticket);

            if (!estaEmHorarioDeAtendimento()) {
                return `${mensagemForaDeHorario()}\n\n🎫 Protocolo registrado: *#${ticket.protocolo}*`;
            }

            return `👤 *Atendimento Humano*

Sua solicitação foi registrada!

🎫 Protocolo: *#${ticket.protocolo}*
🕐 Aguarde, um atendente entrará em contato em breve.

Horário: Seg–Sex 07:50–17:50 | Sáb 07:50–12:00

Digite *0* para voltar ao menu.`;
        }

        default:
            return menuPrincipal();
    }
}

module.exports = mainFlow;
