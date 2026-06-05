const logger = require("../utils/logger");

/**
 * Fila por usuário — garante que mensagens do mesmo usuário
 * sejam processadas em sequência, sem paralelismo.
 *
 * MELHORIA: o .catch() anterior engolia o retorno de task(), então um erro
 * silencioso não chegava ao enviarComRetry() e a mensagem ficava sem resposta.
 * Agora o erro é logado E relançado para o chamador poder tratar.
 */
const queues = {};

async function enqueue(userId, task) {
    const current = queues[userId] || Promise.resolve();

    const next = current.then(() => task());

    // Registra na fila SEM silenciar o erro — o chamador (whatsapp.js) faz o tratamento
    queues[userId] = next.catch(err => {
      logger.error(`❌ Erro na fila [${userId}]: ${err.message}`);
      throw err;
    });

    next.finally(() => {
        setTimeout(() => {
            if (queues[userId] === next) {
                delete queues[userId];
            }
        }, 5000);
    });

    return next;
}

module.exports = { enqueue };
