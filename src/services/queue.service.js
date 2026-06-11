const logger = require("../utils/logger");

// Fila por usuário — garante processamento sequencial sem paralelismo
const queues = {};

async function enqueue(userId, task) {
  const current = queues[userId] || Promise.resolve();
  const next    = current.then(() => task());

  const queued = next.catch(err => {
    logger.error(`❌ Erro na fila [${userId}]: ${err.message}`);
    throw err;
  });

  queues[userId] = queued;

  // Remove a entrada somente após a promise atual completar
  queued.finally(() => {
    if (queues[userId] === queued) delete queues[userId];
  });

  return next;
}

module.exports = { enqueue };
