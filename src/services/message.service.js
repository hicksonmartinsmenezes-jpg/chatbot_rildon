const mainFlow        = require("../flows/main.flow");
const { saveHistory } = require("./history.service");
const { enqueue }     = require("./queue.service");
const { getSession }  = require("./session.service");
const { getBotConfig } = require("./botConfig.service");
const { emitEvent }   = require("./socket.service");
const { reopenTicketIfClosed, handleSatisfactionReply } = require("./ticket.service");
const humanMode       = require("./humanMode.service");
const logger          = require("../utils/logger");

const BOT_FLOW_FALLBACK =
  process.env.BOT_FLOW_FALLBACK ||
  "⚠️ Não consegui processar sua solicitação agora. Tente novamente em instantes ou aguarde um atendente.";

// ─── Rate Limiting ───────────────────────────────────────────────────────────
//
// MELHORIA: o objeto rateLimits era persistido em memória global, o que significa:
//   1. Perde os contadores em cada restart do processo.
//   2. Em múltiplas instâncias (Docker Swarm, PM2 cluster), cada processo tem
//      seu próprio contador — o limite real efetivo é N×RATE_MAX.
//
// Solução aplicada: abstração RateLimiter com implementação em memória padrão,
// pronta para ser trocada por Redis sem alterar o restante do código.
// Para ativar Redis, basta criar src/services/rateLimiter.redis.js e importar aqui.
//
// Estrutura da abstração:
//   - hit(userId): registra uma requisição, retorna true se ainda dentro do limite
//   - cleanup():   remove entradas antigas (chamado periodicamente)
// ─────────────────────────────────────────────────────────────────────────────

const RATE_MAX    = parseInt(process.env.RATE_LIMIT_MAX        || "10");
const RATE_JANELA = parseInt(process.env.RATE_LIMIT_JANELA_MS  || "10000");

class MemoryRateLimiter {
  constructor() {
    this._store = {};

    // Limpeza periódica: remove entradas inativas há mais de 1 hora
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  hit(userId) {
    const agora = Date.now();

    if (!this._store[userId]) {
      this._store[userId] = { count: 0, inicio: agora };
    }

    const r = this._store[userId];

    if (agora - r.inicio > RATE_JANELA) {
      r.count = 0;
      r.inicio = agora;
    }

    r.count++;
    return r.count <= RATE_MAX;
  }

  cleanup() {
    const agora    = Date.now();
    const UMA_HORA = 60 * 60 * 1000;

    for (const userId of Object.keys(this._store)) {
      if (agora - this._store[userId].inicio > UMA_HORA) {
        delete this._store[userId];
      }
    }
  }
}

const rateLimiter = new MemoryRateLimiter();

// ─── Processamento ───────────────────────────────────────────────────────────
// mediaPath/mediaMimetype/mediaFilename (ver migration 017): repassados por
// config/whatsapp.js quando a mensagem recebida tinha foto/áudio/vídeo/
// sticker/documento — já baixados e salvos em disco lá, aqui só precisam
// ser gravados junto com a linha de histórico correspondente.
async function processMessage({ userId, contactName, message, messageId, mediaPath, mediaMimetype, mediaFilename }) {
  const botConfig = await getBotConfig();

  if (botConfig.ativo === false || botConfig.ativo === "false") {
    logger.warn("Bot bloqueado dentro do processMessage.");
    return "";
  }

  if (!rateLimiter.hit(userId)) {
    logger.warn(`Rate limit atingido para ${userId}`);
    return "⚠️ Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente novamente.";
  }

  // Pesquisa de satisfação pendente (ver ticket.service.js)? Precisa vir
  // ANTES de reopenTicketIfClosed — senão a própria resposta da pesquisa
  // (ex: cliente manda "5") reabriria o ticket fechado como se fosse um
  // pedido novo, em vez de só registrar a nota.
  let pesquisa = null;
  try {
    pesquisa = await handleSatisfactionReply({ userId, message });
  } catch (e) {
    logger.warn(`Erro ao checar pesquisa de satisfação: ${e.message}`);
  }
  if (pesquisa) {
    try {
      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message,
        messageId,
        response: pesquisa.response,
        sector: "pesquisa_satisfacao",
        createdAt: new Date(),
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (e) { logger.warn(`Erro ao emitir nova_mensagem (pesquisa): ${e.message}`); }

    try {
      await saveHistory({
        userId,
        contactName,
        message,
        messageId,
        response: pesquisa.response,
        sector: "pesquisa_satisfacao",
        status: "sent",
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (err) {
      logger.warn(`Erro ao salvar histórico (pesquisa de satisfação): ${err.message}`);
    }

    return pesquisa.response;
  }

  // Reabre ticket fechado para que o cliente apareça em Pendentes novamente
  try { await reopenTicketIfClosed(userId); } catch (e) { logger.warn(`Erro ao reabrir ticket: ${e.message}`); }

  // Emite imediatamente para o frontend saber que o cliente mandou mensagem.
  // messageId (id real da mensagem no WhatsApp) é incluído para o painel
  // deduplicar por id exato em vez de um fallback frágil por timestamp —
  // ver BUG CORRIGIDO abaixo, no segundo emit.
  try {
    emitEvent("nova_mensagem", {
      userId,
      contactName,
      message,
      messageId,
      response: null,
      sector: null,
      createdAt: new Date(),
      mediaPath, mediaMimetype, mediaFilename
    });
  } catch (e) { logger.warn(`Erro ao emitir nova_mensagem: ${e.message}`); }

  // ── Takeover humano: atendente assumiu → bot fica em silêncio ──────────────
  // A mensagem do cliente já foi emitida ao painel acima; aqui só persistimos
  // o histórico e NÃO acionamos o fluxo do bot.
  if (humanMode.estaAtivo(userId)) {
    try {
      await saveHistory({
        userId, contactName, message, messageId, response: null, sector: "humano",
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (err) {
      logger.warn(`Erro ao salvar histórico (modo humano): ${err.message}`);
    }
    return "";
  }

  return enqueue(userId, async () => {
    const session = getSession(userId) || {};
    const sector = session.sector || "main";
    let response;
    let flowError = null;

    try {
      // Log de recebimento já feito em whatsapp.js (ponto de entrada) — evita linha duplicada
      response = await mainFlow({ userId, message });
    } catch (err) {
      flowError = err;
      response = BOT_FLOW_FALLBACK;
      logger.error(`[FLOW_ERROR] ${userId}: ${err.stack || err.message}`);
    }

    if (!response) {
      logger.warn(`Fluxo sem resposta para ${userId}`);
      return "";
    }

    try {
      await saveHistory({
        userId,
        contactName,
        message,
        messageId,
        response,
        sector: flowError ? "erro" : sector,
        mediaPath, mediaMimetype, mediaFilename
      });

      // Emite de novo com a resposta do bot já salva.
      //
      // BUG CORRIGIDO: esse segundo emit e o primeiro (logo no início da
      // função) representam a MESMA mensagem do cliente em dois momentos
      // (chegada e depois de processada pelo bot/IA). Nenhum dos dois
      // incluía messageId, então o frontend (frontend/js/12-socket.js)
      // caía num fallback de dedup por "mesmo userId + mesmo texto dentro
      // de 3 segundos". Como o processamento do fluxo/IA pode levar mais
      // de 3s (timeout de até 45s, ver MESSAGE_PROCESSING_TIMEOUT_MS em
      // src/config/whatsapp.js), o segundo emit passava a ser tratado como
      // mensagem NOVA pelo painel → 1 mensagem real virava 2 cards na tela
      // (só visual — o banco recebe um único INSERT). Agora os dois emits
      // (e o saveHistory acima) levam o messageId real do WhatsApp
      // (msg.key.id, capturado em onMessagesUpsert), permitindo o frontend
      // deduplicar por id exato, sem depender de janela de tempo.
      try {
        emitEvent("nova_mensagem", {
          userId,
          contactName,
          message,
          messageId,
          response,
          sector: flowError ? "erro" : sector,
          error: flowError ? true : false,
          createdAt: new Date(),
          mediaPath, mediaMimetype, mediaFilename
        });
      } catch (e) { logger.warn(`Erro ao emitir nova_mensagem (resposta): ${e.message}`); }
    } catch (err) {
      logger.error(`Erro ao salvar histórico: ${err.message}`);
    }

    return response;
  });
}

module.exports = { processMessage };
