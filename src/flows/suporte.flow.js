const { updateSession, clearSession }                       = require("../services/session.service");
const { createTicket, getTicketsByCPF }                     = require("../services/ticket.service");
const { validarCPF, validarNome, formatarCPF,
        validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto, normalizar }                        = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");
const MSG                                                   = require("./messages");

async function suporteFlow(message, userId, session) {
  // CORRIGIDO: normalizar() usado em vez de apenas trim(), igual ao mainFlow
  const msg = normalizar(sanitizarTexto(message));

  if (session.sector === "suporte") {

    if (session.step === "aguardando_problema") {
      const v = validarTamanho(msg, 10);
      if (!v.ok) {
        return v.erro === "minimo"
          ? "⚠️ Por favor, descreva o problema com mais detalhes (mínimo 10 caracteres)."
          : mensagemTamanhoInvalido();
      }
      await updateSession(userId, { problemDescription: sanitizarTexto(message), step: "aguardando_nome" });
      return MSG.suporte.PEDIR_NOME;
    }

    if (session.step === "aguardando_nome") {
      if (!validarNome(sanitizarTexto(message))) return MSG.NOME_INVALIDO;
      await updateSession(userId, { customerName: sanitizarTexto(message), step: "aguardando_cpf" });
      return MSG.suporte.PEDIR_CPF;
    }

    if (session.step === "aguardando_cpf") {
      if (!validarCPF(msg)) return MSG.CPF_INVALIDO;

      const ticket = await createTicket({
        userId,
        type:         "suporte_tecnico",
        sector:       "suporte",
        customerName: session.customerName,
        cpf:          formatarCPF(msg),
        description:  session.problemDescription,
      });

      await clearSession(userId);
      if (!ticket) return "⚠️ Não consegui registrar seu chamado agora.\n\nPor favor, ligue: *(79) 99135-3569*\n\n_Digite *0* para voltar ao menu._";
      notificarAtendente(ticket);
      return MSG.suporte.CHAMADO_ABERTO(ticket);
    }

    if (session.step === "aguardando_cpf_consulta") {
      if (!validarCPF(msg)) return MSG.CPF_INVALIDO;

      const tickets = await getTicketsByCPF(msg);
      await clearSession(userId);

      if (tickets.length === 0) return MSG.suporte.NENHUM_CHAMADO;

      return MSG.suporte.CONSULTA_RESULTADO(tickets);
    }

    switch (msg) {
      case "1":
        await updateSession(userId, { step: "aguardando_problema" });
        return MSG.suporte.PEDIR_PROBLEMA;

      case "2":
        await updateSession(userId, { step: "aguardando_cpf_consulta" });
        return MSG.suporte.PEDIR_CPF_CONSULTA;

      case "3": {
        if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();

        const ticket = await createTicket({
          userId,
          type:         "suporte_humano",
          sector:       "suporte",
          customerName: session.customerName || MSG.NAO_INFORMADO,
          description:  "Cliente solicitou suporte técnico com atendente.",
        });
        await clearSession(userId);
        if (!ticket) return "⚠️ Não consegui registrar sua solicitação agora.\n\nPor favor, ligue: *(79) 99135-3569*\n\n_Digite *0* para voltar ao menu._";
        notificarAtendente(ticket);
        return MSG.suporte.TECNICO_HUMANO(ticket);
      }

      default:
        return MSG.suporte.MENU();
    }
  }

  await updateSession(userId, { sector: "suporte" });
  return MSG.suporte.MENU();
}

module.exports = suporteFlow;
