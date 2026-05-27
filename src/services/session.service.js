/**
 * Gerenciamento de sessões com persistência no PostgreSQL.
 *
 * MELHORIA v7: sessões armazenadas na tabela `sessions` do banco.
 * - Sobrevive a reinicializações do servidor.
 * - Compatível com PM2 fork mode e cluster mode.
 * - Limpeza automática de sessões antigas via TTL configurável.
 *
 * Cache em memória para performance (leituras não vão ao banco).
 * Escrita sempre vai ao banco (upsert) para durabilidade.
 */
const logger = require("../utils/logger");
const pool   = require("../database/postgres");

// ─── Cache em memória ─────────────────────────────────────────────────────────
const sessions = {};
const timers   = {};

const AVISO_MS   = parseInt(process.env.AVISO_MINUTOS   || "3") * 60 * 1000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MINUTOS || "5") * 60 * 1000;
const TTL_HORAS  = parseInt(process.env.SESSION_TTL_HORAS || "24");

let _sendMessage = null;

// ─── Inicialização ────────────────────────────────────────────────────────────
async function setSendMessage(fn) {
  _sendMessage = fn;
  logger.info(`⏱️  Timeout de inatividade ativo (aviso: ${AVISO_MS / 60000}min | encerramento: ${TIMEOUT_MS / 60000}min)`);
  await _carregarSessoes();
  _agendarLimpezaTTL();
}

/** Restaura sessões ativas do banco para o cache em memória. */
async function _carregarSessoes() {
  try {
    const res = await pool.query(
      `SELECT user_id, data FROM sessions
       WHERE updated_at > NOW() - INTERVAL '${TTL_HORAS} hours'`
    );
    for (const row of res.rows) {
      sessions[row.user_id] = row.data;
    }
    logger.info(`${res.rowCount} sessão(ões) restauradas do banco`);
  } catch (err) {
    logger.warn(`Não foi possível restaurar sessões: ${err.message}`);
  }
}

/** Remove sessões inativas além do TTL — roda a cada hora. */
function _agendarLimpezaTTL() {
  setInterval(async () => {
    try {
      const res = await pool.query(
        `DELETE FROM sessions
         WHERE updated_at < NOW() - INTERVAL '${TTL_HORAS} hours'`
      );
      if (res.rowCount > 0) {
        logger.info(`[Sessions] ${res.rowCount} sessão(ões) expirada(s) removida(s)`);
      }
    } catch (err) {
      logger.warn(`[Sessions] Erro na limpeza de TTL: ${err.message}`);
    }
  }, 60 * 60 * 1000);
}

// ─── CRUD de sessão ───────────────────────────────────────────────────────────
function getSession(userId) {
  return sessions[userId] || { sector: "main" };
}

async function updateSession(userId, data) {
  sessions[userId] = { ...getSession(userId), ...data };
  await _persistirSessao(userId);
  resetTimer(userId);
}

async function clearSession(userId) {
  cancelTimer(userId);
  delete sessions[userId];
  await _removerSessao(userId);
}

async function _persistirSessao(userId) {
  try {
    await pool.query(
      `INSERT INTO sessions (user_id, data, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [userId, JSON.stringify(sessions[userId])]
    );
  } catch (err) {
    logger.warn(`[Sessions] Erro ao persistir sessão ${userId}: ${err.message}`);
  }
}

async function _removerSessao(userId) {
  try {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  } catch (err) {
    logger.warn(`[Sessions] Erro ao remover sessão ${userId}: ${err.message}`);
  }
}

// ─── Timers de inatividade ────────────────────────────────────────────────────
function cancelTimer(userId) {
  if (timers[userId]) {
    clearTimeout(timers[userId].aviso);
    clearTimeout(timers[userId].fim);
    delete timers[userId];
  }
}

function resetTimer(userId) {
  cancelTimer(userId);

  const aviso = setTimeout(async () => {
    if (!_sendMessage) return;
    try {
      await _sendMessage(
        userId,
        `⏳ Ainda está aí? Não recebi resposta nos últimos ${AVISO_MS / 60000} minutos.\n\nSe precisar de ajuda, é só digitar *0* para voltar ao menu.\n\nVou encerrar o atendimento em mais ${(TIMEOUT_MS - AVISO_MS) / 60000} minuto(s) caso não haja resposta.`
      );
    } catch (err) {
      logger.error("Erro ao enviar aviso de inatividade:", err.message);
    }
  }, AVISO_MS);

  const fim = setTimeout(async () => {
    if (!_sendMessage) return;
    try {
      await _sendMessage(
        userId,
        "👋 Atendimento encerrado por inatividade.\n\nQuando quiser, é só mandar uma mensagem que estaremos aqui! 😊"
      );
    } catch (err) {
      logger.error("Erro ao enviar mensagem de encerramento:", err.message);
    } finally {
      await clearSession(userId);
    }
  }, TIMEOUT_MS);

  timers[userId] = { aviso, fim };
}

module.exports = { getSession, updateSession, clearSession, setSendMessage };
