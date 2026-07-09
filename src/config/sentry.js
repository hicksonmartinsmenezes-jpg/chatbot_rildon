/**
 * Monitoramento de erros (Sentry).
 *
 * Ativa apenas se SENTRY_DSN estiver definido — sem DSN, tudo vira no-op e o
 * dev local não é afetado. Deve ser inicializado cedo (após o dotenv/env e
 * antes do Express) para instrumentar as requisições.
 */
const Sentry = require("@sentry/node");
const logger = require("../utils/logger");

let enabled = false;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;

  if (!dsn) {
    logger.info("[Sentry] SENTRY_DSN não definido — monitoramento de erros desativado.");
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    // Padrão: só erros (sem tracing de performance). Ajuste via env se quiser.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0)
  });

  enabled = true;
  logger.info(`[Sentry] Monitoramento de erros ativo (env: ${process.env.NODE_ENV || "development"}).`);
}

/** Captura uma exceção. No-op silencioso quando o Sentry está desativado. */
function captureException(err, context) {
  if (!enabled) return;
  try {
    Sentry.captureException(err, context);
  } catch (_) {
    // nunca deixa o monitoramento derrubar a aplicação
  }
}

/** Garante o envio dos eventos pendentes antes de o processo encerrar. */
async function flush(timeoutMs = 2000) {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch (_) {
    // ignora falha de flush
  }
}

module.exports = {
  initSentry,
  captureException,
  flush,
  isEnabled: () => enabled,
  Sentry
};
