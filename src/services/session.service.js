/**
 * Sessões ativas em memória (performance) + persistência em disco.
 *
 * AVISO — PM2 cluster mode:
 * Cada worker mantém seu próprio mapa `sessions` em memória.
 * Em cluster com múltiplos workers, um usuário pode cair em workers
 * diferentes entre mensagens, perdendo o contexto de sessão.
 *
 * Solução recomendada para cluster: mover sessions para Redis ou SQLite
 * compartilhado entre os workers. Em fork mode (1 processo + restart),
 * esta implementação é segura.
 */
const logger = require("../utils/logger");
const { transacao, ler } = require("./db.service");

const sessions = {};
const timers   = {};

const AVISO_MS   = parseInt(process.env.AVISO_MINUTOS   || "3") * 60 * 1000;
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MINUTOS || "5") * 60 * 1000;

const ARQUIVO = "sessions.json";

let _sendMessage = null;

async function setSendMessage(fn) {
    _sendMessage = fn;
    logger.info(`⏱️  Timeout de inatividade ativo (aviso: ${AVISO_MS/60000}min | encerramento: ${TIMEOUT_MS/60000}min)`);

    // Restaura sessões persistidas ao iniciar
    try {
        const salvas = await ler(ARQUIVO);
        for (const s of salvas) {
            if (s.userId && s.data) {
                sessions[s.userId] = s.data;
            }
        }
            logger.info(`${salvas.length} sessão(ões) restauradas`);
    } catch (_) {}
}

function getSession(userId) {
    return sessions[userId] || { sector: "main" };
}

function updateSession(userId, data) {
    sessions[userId] = { ...getSession(userId), ...data };
    _persistSessions();
    resetTimer(userId);
}

function clearSession(userId) {
    cancelTimer(userId);
    delete sessions[userId];
    _persistSessions();
}

function _persistSessions() {
    const lista = Object.entries(sessions).map(([userId, data]) => ({ userId, data }));
    // Fire-and-forget — usa ler/escrita com lock via transacao()
    transacao(ARQUIVO, () => lista).catch(() => {});
}

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
                `⏳ Ainda está aí? Não recebi resposta nos últimos ${AVISO_MS/60000} minutos.\n\nSe precisar de ajuda, é só digitar *0* para voltar ao menu.\n\nVou encerrar o atendimento em mais ${(TIMEOUT_MS - AVISO_MS)/60000} minuto(s) caso não haja resposta.`
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
            clearSession(userId);
        }
    }, TIMEOUT_MS);

    timers[userId] = { aviso, fim };
}

module.exports = { getSession, updateSession, clearSession, setSendMessage };
