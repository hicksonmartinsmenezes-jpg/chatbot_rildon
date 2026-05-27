const { updateSession, clearSession }                        = require("../services/session.service");
const { createTicket }                                       = require("../services/ticket.service");
const { validarTamanho, mensagemTamanhoInvalido }            = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario }  = require("../utils/horario");
const { notificarAtendente }                                 = require("../services/notificacao.service");

async function vendasFlow(message, userId, session) {
    const msg = message.trim();

    if (session.sector === "vendas") {
        if (session.step === "aguardando_orcamento") {
            const v = validarTamanho(msg, 5);
            if (!v.ok) {
                if (v.erro === "minimo") return "⚠️ Por favor, descreva melhor o produto ou serviço que precisa.";
                return mensagemTamanhoInvalido(5);
            }

            const ticket = await createTicket({
                userId,
                type: "orcamento",
                description: msg
            });

            notificarAtendente(ticket);
            clearSession(userId);

            return `✅ *Orçamento solicitado!*

🎫 Protocolo: *#${ticket.protocolo}*
📋 Solicitação: _${msg}_

Um consultor entrará em contato para te atender.
Digite *0* para voltar ao menu.`;
        }

        switch (msg) {
            case "1":
                updateSession(userId, { step: "aguardando_orcamento" });
                return "💬 Descreva o *produto ou serviço* que você precisa de orçamento:";

            case "2":
                return `🛍️ *Nossos Produtos e Serviços*

• Peças elétricas em geral
• Motores e componentes
• Materiais elétricos industriais
• Ferramentas e equipamentos
• Consultoria técnica especializada

Precisa de algo específico? Escolha a opção 1 para orçamento.
Digite *0* para voltar ao menu.`;

            case "3": {
                if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
                const ticket = await createTicket({
                    userId,
                    type: "consultor_vendas",
                    description: "Cliente solicitou falar com consultor de vendas."
                });
                notificarAtendente(ticket);
                clearSession(userId);
                return `👤 Um consultor de vendas entrará em contato!\n\n🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`;
            }

            default:
                return menuVendas();
        }
    }

    updateSession(userId, { sector: "vendas" });
    return menuVendas();
}

function menuVendas() {
    return `🛒 *Vendas / Orçamento*

Como posso ajudar?

1️⃣ - Solicitar orçamento
2️⃣ - Ver produtos e serviços
3️⃣ - Falar com consultor
0️⃣ - Voltar ao menu principal`;
}

module.exports = vendasFlow;
