const { updateSession, clearSession }                       = require("../services/session.service");
const { createTicket, getTicketsByCPF }                     = require("../services/ticket.service");
const { validarCPF, validarNome, formatarCPF,
        validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto }                                    = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");
const MSG                                                   = require("./messages");

async function suporteFlow(message, userId, session) {
  const msg = sanitizarTexto(message.trim());

  if (session.sector === "suporte") {

    // Passo 1: descrição do problema
    if (session.step === "aguardando_problema") {
      const v = validarTamanho(msg, 10);
      if (!v.ok) {
        return v.erro === "minimo"
          ? "⚠️ Por favor, descreva o problema com mais detalhes (mínimo 10 caracteres)."
          : mensagemTamanhoInvalido(10);
      }
      await updateSession(userId, { problemDescription: msg, step: "aguardando_nome" });
      return MSG.suporte.PEDIR_NOME;
    }

    // Passo 2: nome completo
    if (session.step === "aguardando_nome") {
      if (!validarNome(msg)) return MSG.NOME_INVALIDO;
      await updateSession(userId, { customerName: msg, step: "aguardando_cpf" });
      return MSG.suporte.PEDIR_CPF;
    }

    // Passo 3: CPF — cria ticket com todos os dados do cliente
    if (session.step === "aguardando_cpf") {
      if (!validarCPF(msg)) return MSG.CPF_INVALIDO;

      const ticket = await createTicket({
        userId,
        type:         "suporte_tecnico",
        customerName: session.customerName,
        cpf:          formatarCPF(msg),
        description:  session.problemDescription,
      });

      notificarAtendente(ticket);
      await clearSession(userId);

      return MSG.suporte.CHAMADO_ABERTO(ticket);
    }

    // Passo de consulta por CPF
    if (session.step === "aguardando_cpf_consulta") {
      if (!validarCPF(msg)) return MSG.CPF_INVALIDO;

      const tickets = await getTicketsByCPF(msg);
      await clearSession(userId);

      if (tickets.length === 0) return MSG.suporte.NENHUM_CHAMADO;

      // Exibe os últimos 5 e informa o total caso haja mais
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

        // Ticket de suporte humano inclui nome coletado na sessão (se disponível)
        const ticket = await createTicket({
          userId,
          type:         "suporte_humano",
          customerName: session.customerName || MSG.NAO_INFORMADO,
          description:  "Cliente solicitou suporte humano.",
        });
        notificarAtendente(ticket);
        await clearSession(userId);
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
