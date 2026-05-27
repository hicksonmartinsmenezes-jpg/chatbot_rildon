const { updateSession, clearSession }                   = require("../services/session.service");
const { createTicket, getTicketsByCPF }                 = require("../services/ticket.service");
const { validarCPF, validarNome, formatarCPF,
        validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto }                                = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                            = require("../services/notificacao.service");

async function suporteFlow(message, userId, session) {
  const msg = sanitizarTexto(message.trim());

  if (session.sector === "suporte") {

    if (session.step === "aguardando_problema") {
      const v = validarTamanho(msg, 10);
      if (!v.ok) {
        if (v.erro === "minimo") return "⚠️ Por favor, descreva o problema com mais detalhes (mínimo 10 caracteres).";
        return mensagemTamanhoInvalido(10);
      }
      await updateSession(userId, { problemDescription: msg, step: "aguardando_nome" });
      return "📝 Entendido! Agora informe seu *nome completo* (nome e sobrenome).";
    }

    if (session.step === "aguardando_nome") {
      if (!validarNome(msg)) {
        return "⚠️ Por favor, informe seu *nome completo* (nome e sobrenome).";
      }
      await updateSession(userId, { customerName: msg, step: "aguardando_cpf" });
      return "🪪 Informe seu *CPF* (somente números).";
    }

    if (session.step === "aguardando_cpf") {
      if (!validarCPF(msg)) {
        return "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).";
      }

      const ticket = await createTicket({
        userId,
        type:         "suporte_tecnico",
        customerName: session.customerName,
        cpf:          formatarCPF(msg),
        description:  session.problemDescription,
      });

      notificarAtendente(ticket);
      await clearSession(userId);

      return `✅ *Chamado aberto com sucesso!*\n\n👤 Nome: ${ticket.customerName}\n🪪 CPF: ${ticket.cpf}\n🎫 Protocolo: *#${ticket.protocolo}*\n\n📋 Problema relatado:\n_${ticket.description}_\n\nNossa equipe irá analisar e retornar em breve.\nDigite *0* para voltar ao menu.`;
    }

    if (session.step === "aguardando_cpf_consulta") {
      if (!validarCPF(msg)) {
        return "⚠️ CPF inválido. Por favor, informe um *CPF válido* (somente números).";
      }

      const tickets = await getTicketsByCPF(msg);
      await clearSession(userId);

      if (tickets.length === 0) {
        return `🔍 Nenhum chamado encontrado para o CPF informado.\n\nDigite *0* para voltar ao menu.`;
      }

      const lista = tickets
        .slice(-5)
        .map(t => `• *#${t.protocolo}* — ${t.type} — _${t.status}_\n  📅 ${new Date(t.createdAt).toLocaleDateString("pt-BR")}`)
        .join("\n\n");

      return `🔍 *Chamados encontrados (${tickets.length}):*\n\n${lista}\n\nDigite *0* para voltar ao menu.`;
    }

    switch (msg) {
      case "1":
        await updateSession(userId, { step: "aguardando_problema" });
        return "🔧 Descreva o *problema técnico* que você está enfrentando:";

      case "2":
        await updateSession(userId, { step: "aguardando_cpf_consulta" });
        return "🔍 Informe seu *CPF* para consultar seus atendimentos:";

      case "3": {
        if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
        const ticket = await createTicket({
          userId,
          type:        "suporte_humano",
          description: "Cliente solicitou suporte humano.",
        });
        notificarAtendente(ticket);
        await clearSession(userId);
        return `👤 Você será atendido por um técnico em breve.\n\n🎫 Protocolo: *#${ticket.protocolo}*\n\nDigite *0* para voltar ao menu.`;
      }

      default:
        return menuSuporte();
    }
  }

  await updateSession(userId, { sector: "suporte" });
  return menuSuporte();
}

function menuSuporte() {
  return `🔧 *Suporte Técnico*\n\nComo posso ajudar?\n\n1️⃣ - Abrir chamado técnico\n2️⃣ - Consultar chamado por CPF\n3️⃣ - Falar com técnico humano\n0️⃣ - Voltar ao menu principal`;
}

module.exports = suporteFlow;
