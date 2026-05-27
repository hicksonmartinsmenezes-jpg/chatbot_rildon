const { updateSession, clearSession }                   = require("../services/session.service");
const { createTicket, getTicketsByCPF }                 = require("../services/ticket.service");
const { validarCPF, validarNome, formatarCPF,
        validarTamanho, mensagemTamanhoInvalido }        = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                            = require("../services/notificacao.service");

async function suporteFlow(message, userId, session) {
    const msg = message.trim();

    if (session.sector === "suporte") {

        // — Abrir chamado: descrição do problema —
        if (session.step === "aguardando_problema") {
            const v = validarTamanho(msg, 10);
            if (!v.ok) {
                if (v.erro === "minimo") return "⚠️ Por favor, descreva o problema com mais detalhes (mínimo 10 caracteres).";
                return mensagemTamanhoInvalido(10);
            }
            updateSession(userId, { problemDescription: msg, step: "aguardando_nome" });
            return "📝 Entendido! Agora informe seu *nome completo* (nome e sobrenome).";
        }

        if (session.step === "aguardando_nome") {
            if (!validarNome(msg)) {
                return "⚠️ Por favor, informe seu *nome completo* (nome e sobrenome).";
            }
            updateSession(userId, { customerName: msg, step: "aguardando_cpf" });
            return "🪪 Informe seu *CPF* (somente números).";
        }

        if (session.step === "aguardando_cpf") {
            if (!validarCPF(msg)) {
                return "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).";
            }

            const ticket = await createTicket({
                userId,
                type: "suporte_tecnico",
                customerName: session.customerName,
                cpf: formatarCPF(msg),
                description: session.problemDescription
            });

            notificarAtendente(ticket);
            clearSession(userId);

            return `✅ *Chamado aberto com sucesso!*

👤 Nome: ${ticket.customerName}
🪪 CPF: ${ticket.cpf}
🎫 Protocolo: *#${ticket.protocolo}*

📋 Problema relatado:
_${ticket.description}_

Nossa equipe irá analisar e retornar em breve.
Digite *0* para voltar ao menu.`;
        }

        // — Consulta por CPF (bug corrigido) —
        if (session.step === "aguardando_cpf_consulta") {
            if (!validarCPF(msg)) {
                return "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).";
            }

            const tickets = await getTicketsByCPF(msg);
            clearSession(userId);

            if (tickets.length === 0) {
                return `🔍 Nenhum chamado encontrado para o CPF informado.\n\nDigite *0* para voltar ao menu.`;
            }

            const lista = tickets
                .slice(-5) // últimos 5
                .map(t => `• *#${t.protocolo}* — ${t.type} — _${t.status}_\n  📅 ${new Date(t.createdAt).toLocaleDateString("pt-BR")}`)
                .join("\n\n");

            return `🔍 *Chamados encontrados (${tickets.length}):*\n\n${lista}\n\nDigite *0* para voltar ao menu.`;
        }

        // — Menu interno do suporte —
        switch (msg) {
            case "1":
                updateSession(userId, { step: "aguardando_problema" });
                return "🔧 Descreva o *problema técnico* que você está enfrentando:";

            case "2":
                updateSession(userId, { step: "aguardando_cpf_consulta" });
                return "🔍 Informe seu *CPF* para consultar seus atendimentos:";

            case "3": {
                if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
                const ticket = await createTicket({
                    userId,
                    type: "suporte_humano",
                    description: "Cliente solicitou suporte humano."
                });
                notificarAtendente(ticket);
                clearSession(userId);
                return `👤 Você será atendido por um técnico em breve.\n\n🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`;
            }

            default:
                return menuSuporte();
        }
    }

    updateSession(userId, { sector: "suporte" });
    return menuSuporte();
}

function menuSuporte() {
    return `🔧 *Suporte Técnico*

Como posso ajudar?

1️⃣ - Abrir chamado técnico
2️⃣ - Consultar chamado por CPF
3️⃣ - Falar com técnico humano
0️⃣ - Voltar ao menu principal`;
}

module.exports = suporteFlow;
