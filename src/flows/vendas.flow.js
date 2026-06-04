const { updateSession, clearSession }                       = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { validarNome, validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto, normalizar }                        = require("../utils/validators");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente }                                = require("../services/notificacao.service");
const MSG                                                   = require("./messages");

async function vendasFlow(message, userId, session) {
  // CORRIGIDO: normalizar() usado em vez de apenas trim()
  const msg = normalizar(sanitizarTexto(message));

  if (session.sector === "vendas") {

    if (session.step === "aguardando_nome") {
      if (!validarNome(sanitizarTexto(message))) return MSG.NOME_INVALIDO;
      await updateSession(userId, { customerName: sanitizarTexto(message), step: "aguardando_orcamento" });
      return MSG.vendas.PEDIR_ORCAMENTO;
    }

    if (session.step === "aguardando_orcamento") {
      const v = validarTamanho(msg, 5);
      if (!v.ok) {
        return v.erro === "minimo"
          ? "⚠️ Por favor, descreva melhor o produto ou serviço que precisa."
          : mensagemTamanhoInvalido();
      }

      const ticket = await createTicket({
        userId,
        type:         "orcamento",
        customerName: session.customerName || MSG.NAO_INFORMADO,
        description:  sanitizarTexto(message),
      });
      notificarAtendente(ticket);
      await clearSession(userId);

      return MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
    }

    switch (msg) {
      case "1":
        await updateSession(userId, { step: "aguardando_nome" });
        return MSG.vendas.PEDIR_NOME;

      case "2":
        // CORRIGIDO: clearSession após resposta terminal informativa
        await clearSession(userId);
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
