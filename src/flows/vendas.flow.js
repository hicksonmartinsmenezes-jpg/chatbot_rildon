const { updateSession, clearSession }                       = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { validarNome, validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto }                                    = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");
const MSG                                                   = require("./messages");

async function vendasFlow(message, userId, session) {
  const msg = sanitizarTexto(message.trim());

  if (session.sector === "vendas") {

    // Passo 1: coleta nome do cliente antes do orçamento
    if (session.step === "aguardando_nome") {
      if (!validarNome(msg)) return MSG.NOME_INVALIDO;
      await updateSession(userId, { customerName: msg, step: "aguardando_orcamento" });
      return MSG.vendas.PEDIR_ORCAMENTO;
    }

    // Passo 2: descrição do orçamento — cria ticket com nome do cliente
    if (session.step === "aguardando_orcamento") {
      const v = validarTamanho(msg, 5);
      if (!v.ok) {
        return v.erro === "minimo"
          ? "⚠️ Por favor, descreva melhor o produto ou serviço que precisa."
          : mensagemTamanhoInvalido(5);
      }

      const ticket = await createTicket({
        userId,
        type:         "orcamento",
        customerName: session.customerName || MSG.NAO_INFORMADO,
        description:  msg,
      });
      notificarAtendente(ticket);
      await clearSession(userId);

      return MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
    }

    switch (msg) {
      case "1":
        // Coleta nome antes de pedir o orçamento
        await updateSession(userId, { step: "aguardando_nome" });
        return MSG.vendas.PEDIR_NOME;

      case "2":
        return MSG.vendas.PRODUTOS;

      case "3": {
        if (!estaEmHorarioDeAtendimento()) return mensagemForaDeHorario();
        const ticket = await createTicket({
          userId,
          type:         "consultor_vendas",
          customerName: session.customerName || MSG.NAO_INFORMADO,
          description:  "Cliente solicitou falar com consultor de vendas.",
        });
        notificarAtendente(ticket);
        await clearSession(userId);
        return MSG.vendas.CONSULTOR(ticket);
      }

      default:
        return MSG.vendas.MENU();
    }
  }

  await updateSession(userId, { sector: "vendas" });
  return MSG.vendas.MENU();
}

module.exports = vendasFlow;
