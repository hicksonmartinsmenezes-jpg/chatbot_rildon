const mainFlow    = require("../flows/main.flow");
const { saveHistory } = require("./history.service");
const { enqueue }     = require("./queue.service");
const { getSession }  = require("./session.service");
const { getBotConfig } = require("./botConfig.service");
const { emitEvent }   = require("./socket.service");
const logger          = require("../utils/logger");

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const rateLimits = {};
const RATE_MAX   = parseInt(process.env.RATE_LIMIT_MAX       || "10");
const RATE_JANELA = parseInt(process.env.RATE_LIMIT_JANELA_MS || "10000");

// Remove entradas de usuários que já não estão ativos há mais de 1 hora
// para evitar crescimento indefinido do objeto em memória.
setInterval(() => {
  const agora = Date.now();
  const UMA_HORA = 60 * 60 * 1000;
  for (const userId of Object.keys(rateLimits)) {
    if (agora - rateLimits[userId].inicio > UMA_HORA) {
      delete rateLimits[userId];
    }
  }
}, 10 * 60 * 1000); // roda a cada 10 minutos

function verificarRateLimit(userId) {
  const agora = Date.now();

  if (!rateLimits[userId]) {
    rateLimits[userId] = { count: 0, inicio: agora };
  }

  const r = rateLimits[userId];

  if (agora - r.inicio > RATE_JANELA) {
    r.count = 0;
    r.inicio = agora;
  }

  r.count++;
  return r.count <= RATE_MAX;
}

// ─── Processamento ───────────────────────────────────────────────────────────
async function processMessage({ userId, contactName, message }) {
  const botConfig = await getBotConfig();

  if (botConfig.ativo === false) {
    logger.warn("Bot bloqueado dentro do processMessage.");
    return "";
  }

  if (!verificarRateLimit(userId)) {
    logger.warn(`Rate limit atingido para ${userId}`);
    return "⚠️ Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente novamente.";
  }

  return enqueue(userId, async () => {
    logger.info(`Mensagem recebida de ${userId}: ${message}`);

    const response = await mainFlow({ userId, message });
    const session  = getSession(userId);

    try {
      await saveHistory({
        userId,
        contactName,
        message,
        response,
        sector: session.sector || "main"
      });

      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message,
        response,
        sector:    session.sector || "main",
        createdAt: new Date()
      });
    } catch (err) {
      logger.error(`Erro ao salvar histórico: ${err.message}`);
    }

    return response;
  });
}

module.exports = { processMessage };
