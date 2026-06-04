const mainFlow        = require("../flows/main.flow");
const { saveHistory } = require("./history.service");
const { enqueue }     = require("./queue.service");
const { getSession }  = require("./session.service");
const { getBotConfig } = require("./botConfig.service");
const { emitEvent }   = require("./socket.service");
const logger          = require("../utils/logger");

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
    setInterval(() => this.cleanup(), 10 * 60 * 1000);
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
async function processMessage({ userId, contactName, message }) {
  const botConfig = await getBotConfig();

  if (botConfig.ativo === false || botConfig.ativo === "false") {
    logger.warn("Bot bloqueado dentro do processMessage.");
    return "";
  }

  if (!rateLimiter.hit(userId)) {
    logger.warn(`Rate limit atingido para ${userId}`);
    return "⚠️ Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente novamente.";
  }

  return enqueue(userId, async () => {
    logger.info(`Mensagem recebida de ${userId}: ${message}`);

    const response = await mainFlow({ userId, message });

    if (!response) {
      logger.warn(`Fluxo sem resposta para ${userId}`);
      return "";
    }

    const session = getSession(userId) || {};
    const sector = session.sector || "main";

    try {
      await saveHistory({
        userId,
        contactName,
        message,
        response,
        sector
      });

      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message,
        response,
        sector,
        createdAt: new Date()
      });
    } catch (err) {
      logger.error(`Erro ao salvar histórico: ${err.message}`);
    }

    return response;
  });
}

module.exports = { processMessage };
