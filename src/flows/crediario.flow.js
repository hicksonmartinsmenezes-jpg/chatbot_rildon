const { updateSession, clearSession }                 = require("../services/session.service");
const { createTicket }                                = require("../services/ticket.service");
const { validarNome, validarCPF, validarTamanho,
        mensagemTamanhoInvalido,
        sanitizarTexto, normalizar }                  = require("../utils/validators");
const { notificarAtendente }                          = require("../services/notificacao.service");
const logger                                          = require("../utils/logger");
const MSG                                             = require("./messages");

const MSG_TICKET_FALHOU =
  "⚠️ Não consegui registrar sua solicitação agora.\n\n" +
  "Por favor, ligue diretamente: *(79) 99135-3569*\n\n" +
  "_Digite *0* para voltar ao menu._";

async function _criarTicketCrediario(dados) {
  try {
    const ticket = await createTicket(dados);
    if (!ticket) throw new Error("createTicket retornou nulo");
    return ticket;
  } catch (err) {
    logger.error(`[crediario._criarTicket] ${err.message}`);
    return null;
  }
}

// Palavras que escapam para o menu principal
const ESCAPE = new Set(["0", "menu", "voltar", "cancelar", "inicio"]);

async function crediarioFlow(message, userId, session) {
  const msg          = normalizar(sanitizarTexto(message));
  const msgSemPontos = msg.replace(/[^\p{L}\p{N}\s]/gu, "").trim();

  // ── Escape universal ────────────────────────────────────────────────────────
  if (ESCAPE.has(msg) || ESCAPE.has(msgSemPontos)) {
    await clearSession(userId);
    return null; // mainFlow exibirá o menu principal
  }

  // ── Inicializa sector se ainda não está em crediário ───────────────────────
  if (session.sector !== "crediario") {
    await updateSession(userId, { sector: "crediario" });
    return MSG.crediario.MENU();
  }

  // ── Etapa: Nome ────────────────────────────────────────────────────────────
  if (session.step === "aguardando_nome_cred") {
    if (!validarNome(sanitizarTexto(message))) {
      return MSG.NOME_INVALIDO + MSG.ESCAPE_DICA;
    }
    await updateSession(userId, {
      customerName: sanitizarTexto(message),
      step: "aguardando_cpf",
    });
    return MSG.crediario.PEDIR_CPF + MSG.ESCAPE_DICA;
  }

  // ── Etapa: CPF ─────────────────────────────────────────────────────────────
  if (session.step === "aguardando_cpf") {
    const cpfNumeros = msg.replace(/\D/g, "");
    if (!validarCPF(cpfNumeros)) {
      return MSG.CPF_INVALIDO + MSG.ESCAPE_DICA;
    }
    await updateSession(userId, {
      cpf:  cpfNumeros,
      step: "aguardando_motivo_cred",
    });
    return MSG.crediario.PEDIR_MOTIVO + MSG.ESCAPE_DICA;
  }

  // ── Etapa: Motivo ──────────────────────────────────────────────────────────
  if (session.step === "aguardando_motivo_cred") {
    const v = validarTamanho(msg, 5);
    if (!v.ok) {
      return v.erro === "minimo"
        ? "⚠️ Por favor, descreva melhor o que precisa." + MSG.ESCAPE_DICA
        : mensagemTamanhoInvalido();
    }

    const ticket = await _criarTicketCrediario({
      userId,
      type:         "crediario",
      sector:       "financeiro",
      customerName: session.customerName || MSG.NAO_INFORMADO,
      description:  sanitizarTexto(message),
    });
    await clearSession(userId);
    if (!ticket) return MSG_TICKET_FALHOU;
    notificarAtendente(ticket);
    return MSG.crediario.SOLICITACAO_REGISTRADA(ticket);
  }

  // ── Etapa: Consultar situação (opção 2) ─────────────────────────────────────
  if (session.step === "aguardando_nome_consulta_cred") {
    if (!validarNome(sanitizarTexto(message))) {
      return MSG.NOME_INVALIDO + MSG.ESCAPE_DICA;
    }
    await updateSession(userId, {
      customerName: sanitizarTexto(message),
      step: "aguardando_cpf_consulta",
    });
    return MSG.crediario.PEDIR_CPF + MSG.ESCAPE_DICA;
  }

  if (session.step === "aguardando_cpf_consulta") {
    const cpfNumeros = msg.replace(/\D/g, "");
    if (!validarCPF(cpfNumeros)) {
      return MSG.CPF_INVALIDO + MSG.ESCAPE_DICA;
    }
    const ticket = await _criarTicketCrediario({
      userId,
      type:         "consulta_crediario",
      sector:       "financeiro",
      customerName: session.customerName || MSG.NAO_INFORMADO,
      description:  `Consulta de situação de crediário`,
    });
    await clearSession(userId);
    if (!ticket) return MSG_TICKET_FALHOU;
    notificarAtendente(ticket);
    return MSG.crediario.SOLICITACAO_REGISTRADA(ticket);
  }

  // ── Sub-menu do crediário ──────────────────────────────────────────────────
  switch (msg) {
    case "1": {
      await updateSession(userId, { step: "aguardando_nome_cred" });
      return MSG.crediario.PEDIR_NOME + MSG.ESCAPE_DICA;
    }

    case "2": {
      await updateSession(userId, { step: "aguardando_nome_consulta_cred" });
      return MSG.crediario.PEDIR_NOME + MSG.ESCAPE_DICA;
    }

    case "3": {
      const ticket = await _criarTicketCrediario({
        userId,
        type:         "atendente_financeiro",
        sector:       "financeiro",
        customerName: session.customerName || MSG.NAO_INFORMADO,
        description:  "Cliente solicitou falar com o financeiro",
      });
      await clearSession(userId);
      if (!ticket) return MSG_TICKET_FALHOU;
      notificarAtendente(ticket);
      return MSG.crediario.ATENDENTE(ticket);
    }

    default:
      return MSG.crediario.MENU();
  }
}

module.exports = crediarioFlow;
