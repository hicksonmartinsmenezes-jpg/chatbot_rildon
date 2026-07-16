const { updateSession, clearSession, finalizarComTicket }    = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { validarNome, validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto, normalizar }                        = require("../utils/validators");
const { notificarAtendente }                                = require("../services/notificacao.service");
const logger                                                = require("../utils/logger");
const MSG                                                   = require("./messages");

const MSG_TICKET_FALHOU =
  "⚠️ Não consegui registrar sua solicitação agora.\n\n" +
  "Por favor, ligue diretamente: *(79) 99135-3569*\n\n" +
  "_Digite *0* para voltar ao menu._";

async function _criarTicketVendas(dados) {
  try {
    const ticket = await createTicket(dados);
    if (!ticket) throw new Error("createTicket retornou nulo");
    return ticket;
  } catch (err) {
    logger.error(`[vendas._criarTicket] ${err.message}`);
    return null;
  }
}

// Finaliza o orçamento: monta a descrição (veículo + produto),
// cria o ticket e encerra a sessão preservando o histórico da IA (ver
// finalizarComTicket em session.service.js — corrige o bug de perguntas
// de acompanhamento tipo "quando?" perderem contexto).
async function _finalizarOrcamento(userId, session, veiculo, produtoTexto) {
  const veiculoPrefix = veiculo && veiculo !== "Não informado" ? `Veículo: ${veiculo} | ` : "";
  const descricao      = `${veiculoPrefix}Produto: ${produtoTexto}`;

  const ticket = await _criarTicketVendas({
    userId,
    type:         "orcamento",
    customerName: session.customerName || MSG.NAO_INFORMADO,
    description:  descricao,
  });
  await finalizarComTicket(userId, ticket);
  if (!ticket) return MSG_TICKET_FALHOU;
  notificarAtendente(ticket);
  return MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
}

// Palavras que escapam para o menu principal em qualquer etapa de coleta
const ESCAPE = new Set(["0", "menu", "voltar", "cancelar", "inicio"]);

async function vendasFlow(message, userId, session) {
  const msg           = normalizar(sanitizarTexto(message));
  const msgSemPontos  = msg.replace(/[^\p{L}\p{N}\s]/gu, "").trim();

  if (session.sector === "vendas") {

    // ── Escape universal: volta ao menu em qualquer etapa ──────────────────────
    if (ESCAPE.has(msg) || ESCAPE.has(msgSemPontos)) {
      await clearSession(userId);
      return null; // mainFlow exibirá o menu principal
    }

    // ── Etapa 1: Nome ──────────────────────────────────────────────────────────
    if (session.step === "aguardando_nome") {
      if (!validarNome(sanitizarTexto(message))) {
        return MSG.NOME_INVALIDO + MSG.ESCAPE_DICA;
      }
      await updateSession(userId, {
        customerName: sanitizarTexto(message),
        step: "aguardando_veiculo",
      });
      return MSG.vendas.PEDIR_VEICULO;
    }

    // ── Etapa 2: Veículo ───────────────────────────────────────────────────────
    if (session.step === "aguardando_veiculo") {
      const veiculo = msg === "pular" ? null : sanitizarTexto(message);
      const veiculoFinal = veiculo || "Não informado";

      // BUG CORRIGIDO: o cliente já tinha dito o que precisava na 1ª
      // mensagem (ex: "quero orçamento de uma palheta") — sem isso, o
      // fluxo perguntava "qual peça ou serviço você precisa?" de novo,
      // o cliente respondia "já falei" (frustrado) e ISSO virava a
      // descrição do orçamento. Se produtoInicial já é descritivo o
      // bastante, pula a etapa 3 e finaliza direto.
      const produtoInicial = session.produtoInicial ? sanitizarTexto(session.produtoInicial) : "";
      const produtoValido  = validarTamanho(normalizar(produtoInicial), 5).ok;

      if (produtoValido) {
        return _finalizarOrcamento(userId, session, veiculoFinal, produtoInicial);
      }

      await updateSession(userId, {
        veiculo: veiculoFinal,
        step: "aguardando_orcamento",
      });
      return MSG.vendas.PEDIR_ORCAMENTO + MSG.ESCAPE_DICA;
    }

    // ── Etapa 3: Produto / descrição ───────────────────────────────────────────
    if (session.step === "aguardando_orcamento") {
      const v = validarTamanho(msg, 5);
      if (!v.ok) {
        return v.erro === "minimo"
          ? "⚠️ Por favor, descreva melhor o produto que precisa." + MSG.ESCAPE_DICA
          : mensagemTamanhoInvalido();
      }

      return _finalizarOrcamento(userId, session, session.veiculo, sanitizarTexto(message));
    }

    // ── Sub-menu de vendas ─────────────────────────────────────────────────────
    switch (msg) {
      case "1": {
        const nomeExistente = session.customerName;
        if (nomeExistente) {
          const primeiroNome = nomeExistente.trim().split(" ")[0];
          await updateSession(userId, { step: "aguardando_veiculo" });
          return `Certo, *${primeiroNome}*! ` + MSG.vendas.PEDIR_VEICULO + MSG.ESCAPE_DICA;
        }
        await updateSession(userId, { step: "aguardando_nome" });
        return MSG.vendas.PEDIR_NOME + MSG.ESCAPE_DICA;
      }

      default:
        return MSG.vendas.MENU();
    }
  }

  await updateSession(userId, { sector: "vendas" });
  return MSG.vendas.MENU();
}

module.exports = vendasFlow;
