const { updateSession, clearSession, finalizarComTicket } = require("../services/session.service");
const { createTicket }                                = require("../services/ticket.service");
const { validarNome, validarCPF, validarTamanho,
        mensagemTamanhoInvalido,
        sanitizarTexto, normalizar }                  = require("../utils/validators");
const { notificarAtendente }                          = require("../services/notificacao.service");
const logger                                          = require("../utils/logger");
const MSG                                             = require("./messages");

// Mesmo bug corrigido em vendas.flow.js (ver _pareceMudancaDeAssunto lá): o
// cliente pode mudar de assunto no meio da coleta (nome/motivo) pedindo algo
// de OUTRO setor, e o texto vira literalmente o campo errado do ticket.
// Deliberadamente NÃO inclui "peça"/"orçamento"/"conserto" — mencionar peças é
// o motivo NORMAL de pedir crediário ("preciso financiar peças pro carro"),
// então isso seria um falso positivo constante, não uma mudança de assunto de
// verdade. Cobre só assuntos claramente de OUTROS setores (horário, endereço,
// falar com a equipe, reclamação). Também não é aplicado na etapa de CPF, que
// já tem validação de formato própria (validarCPF já rejeita texto que não
// seja CPF válido).
const MUDANCA_ASSUNTO_RE =
  /\bhorario de funcionamento\b|\bque horas (abre|fecha)\b|\bonde fica\b|\bendereco\b|\blocalizacao\b|\bfalar com a equipe\b|\bfalar com o responsavel\b|\breclamacao\b|\bquero reclamar\b/;

function _pareceMudancaDeAssunto(message) {
  const normalizado = normalizar(message);
  return MUDANCA_ASSUNTO_RE.test(normalizado);
}

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

  // ── Detecta mudança de assunto nas etapas de texto livre (nome/motivo) ─────
  // Não aplicado nas etapas de CPF: validarCPF já rejeita texto que não seja
  // CPF válido, então uma pergunta fora de contexto ali já cai no fluxo de
  // "CPF inválido" em vez de virar dado salvo incorretamente.
  const ETAPAS_TEXTO_LIVRE = new Set([
    "aguardando_nome_cred",
    "aguardando_motivo_cred",
    "aguardando_nome_consulta_cred",
  ]);
  if (ETAPAS_TEXTO_LIVRE.has(session.step) && _pareceMudancaDeAssunto(message)) {
    logger.warn(`[crediarioFlow] Mudança de assunto detectada, saindo do fluxo de crediário — userId=${userId} step=${session.step} msg="${message}"`);
    await clearSession(userId);
    return (
      "Percebi que sua pergunta é sobre outro assunto! 😊\n\n" +
      "Digite *0* para ver o menu principal e escolher a opção certa (orçamento de peças, outros contatos, horário, etc.)."
    );
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
      sector:       "geral",
      customerName: session.customerName || MSG.NAO_INFORMADO,
      description:  sanitizarTexto(message),
    });
    await finalizarComTicket(userId, ticket);
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
      sector:       "geral",
      customerName: session.customerName || MSG.NAO_INFORMADO,
      description:  `Consulta de situação de crediário — CPF: ${cpfNumeros}`,
    });
    await finalizarComTicket(userId, ticket);
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

    default:
      return MSG.crediario.MENU();
  }
}

module.exports = crediarioFlow;
