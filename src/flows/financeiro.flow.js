const { updateSession, clearSession }                        = require("../services/session.service");
const { createTicket }                                       = require("../services/ticket.service");
const { validarTamanho, mensagemTamanhoInvalido }            = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario }  = require("../utils/horario");
const { notificarAtendente }                                 = require("../services/notificacao.service");

async function financeiroFlow(message, userId, session) {
    const msg = message.trim();

    if (session.sector === "financeiro") {
        if (session.step === "aguardando_duvida") {
            const v = validarTamanho(msg, 5);
            if (!v.ok) {
                if (v.erro === "minimo") return "⚠️ Por favor, descreva melhor sua dúvida.";
                return mensagemTamanhoInvalido(5);
            }

            const ticket = await createTicket({
                userId,
                type: "duvida_financeira",
                description: msg
            });

            notificarAtendente(ticket);
            clearSession(userId);

            return `✅ *Dúvida registrada!*

🎫 Protocolo: *#${ticket.protocolo}*
📋 Dúvida: _${msg}_

Nossa equipe financeira irá responder em horário comercial.
Digite *0* para voltar ao menu.`;
        }

        switch (msg) {
            case "1":
                updateSession(userId, { step: "aguardando_duvida" });
                return "💬 Descreva sua *dúvida sobre pagamento* ou envie seu CPF/CNPJ para consulta:";

            case "2":
                return `💳 *Formas de Pagamento*

• Dinheiro
• PIX
• Cartão de débito e crédito
• Boleto bancário (consulte prazo)

Dúvidas? Use a opção 1.
Digite *0* para voltar ao menu.`;

            case "3": {
                if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
                const ticket = await createTicket({
                    userId,
                    type: "atendente_financeiro",
                    description: "Cliente solicitou atendente do financeiro."
                });
                notificarAtendente(ticket);
                clearSession(userId);
                return `👤 Um atendente do financeiro entrará em contato!\n\n🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`;
            }

            default:
                return menuFinanceiro();
        }
    }

    updateSession(userId, { sector: "financeiro" });
    return menuFinanceiro();
}

function menuFinanceiro() {
    return `💰 *Financeiro*

Como posso ajudar?

1️⃣ - Dúvidas sobre pagamento / consulta
2️⃣ - Formas de pagamento aceitas
3️⃣ - Falar com financeiro
0️⃣ - Voltar ao menu principal`;
}

module.exports = financeiroFlow;
