const { updateSession, clearSession } = require("../services/session.service");
const { createTicket } = require("../services/ticket.service");
const {
  validarCPF,
  validarCNPJ,
  validarNome,
  validarTamanho,
  mensagemTamanhoInvalido,
  sanitizarTexto,
  normalizar
} = require("../utils/validators");
const {
  estaEmHorarioDeAtendimento,
  mensagemForaDeHorario
} = require("../utils/horario");
const { notificarAtendente } = require("../services/notificacao.service");
const MSG = require("./messages");

function validarDocumento(str) {
  const apenasNumeros = String(str || "").replace(/\D/g, "");

  if (apenasNumeros.length === 11) {
    return validarCPF(apenasNumeros) ? apenasNumeros : null;
  }

  if (apenasNumeros.length === 14) {
    return validarCNPJ(apenasNumeros) ? apenasNumeros : null;
  }

  return null;
}

async function financeiroFlow(message, userId, session) {
  // CORRIGIDO: normalizar() usado em vez de apenas trim()
  const msg = normalizar(sanitizarTexto(message));

  if (session.sector === "financeiro") {
    if (session.step === "aguardando_nome") {
      if (!validarNome(sanitizarTexto(message))) {
        return MSG.NOME_INVALIDO;
      }

      await updateSession(userId, {
        nome: sanitizarTexto(message),
        step: "aguardando_duvida"
      });

      return MSG.financeiro.PEDIR_DUVIDA;
    }

    if (session.step === "aguardando_duvida") {
      const nomeCliente = session.nome || MSG.NAO_INFORMADO;
      const documento = validarDocumento(msg);
      const somenteNumero = /^\d+$/.test(msg.replace(/[\s.\-\/]/g, ""));

      if (!documento && somenteNumero) {
        return MSG.financeiro.DOCUMENTO_INVALIDO;
      }

      if (!documento) {
        const v = validarTamanho(msg, 5);

        if (!v.ok) {
          return v.erro === "minimo"
            ? "⚠️ Por favor, descreva melhor sua dúvida financeira ou envie CPF/CNPJ."
            : mensagemTamanhoInvalido();
        }
      }

      const ticket = await createTicket({
        userId,
        type: "duvida_financeira",
        sector: "financeiro",
        cpf: documento || null,
        customerName: nomeCliente,
        description: documento ? "Consulta financeira" : sanitizarTexto(message)
      });

      notificarAtendente(ticket);
      await clearSession(userId);

      return MSG.financeiro.DUVIDA_REGISTRADA(ticket, documento, msg);
    }

    switch (msg) {
      case "1":
        // CORRIGIDO: sector já está em session; não atribuir duas vezes
        await updateSession(userId, { step: "aguardando_nome" });
        return MSG.financeiro.PEDIR_NOME;

      case "2":
        return MSG.financeiro.FORMAS_PAGAMENTO;

      case "3": {
        if (!estaEmHorarioDeAtendimento()) {
          return mensagemForaDeHorario();
        }

        const nomeCliente = session.nome || MSG.NAO_INFORMADO;

        const ticket = await createTicket({
          userId,
          type: "atendente_financeiro",
          sector: "financeiro",
          customerName: nomeCliente,
          description: "Cliente solicitou atendente do financeiro."
        });

        notificarAtendente(ticket);
        await clearSession(userId);

        return MSG.financeiro.ATENDENTE(ticket);
      }

      default:
        return MSG.financeiro.MENU();
    }
  }

  await updateSession(userId, {
    sector: "financeiro",
    step: "menu_financeiro"
  });

  return MSG.financeiro.MENU();
}

module.exports = financeiroFlow;
