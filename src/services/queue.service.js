const logger = require("../utils/logger");

/**
 * Fila por usuário — garante que mensagens do mesmo usuário
 * sejam processadas em sequência, sem paralelismo.
 *
 * Correção: a limpeza agora verifica se a Promise referenciada
 * ainda é a mesma antes de deletar, evitando apagar uma fila nova.
 */
const queues = {};

async function enqueue(userId, task) {
    const current = queues[userId] || Promise.resolve();

    const next = current
        .then(() => task())
        .catch(err => logger.error(`❌ Erro na fila [${userId}]:`, err.message));

    queues[userId] = next;

    next.finally(() => {
        setTimeout(() => {
            // Só limpa se a fila ainda aponta para esta Promise
            if (queues[userId] === next) {
                delete queues[userId];
            }
        }, 5000);
    });

    return next;
}

module.exports = { enqueue };
