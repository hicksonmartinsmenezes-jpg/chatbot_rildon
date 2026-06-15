const logger = require("../utils/logger");

// Fila por usuário — garante processamento sequencial sem paralelismo
const queues = {};

async function enqueue(userId, task) {
  // Backbone nunca rejeita: falha de uma tarefa não bloqueia a próxima na fila
  const backbone = (queues[userId] || Promise.resolve()).catch(() => {});
  const next     = backbone.then(() => task());

  // O que fica em queues é a versão silenciada (para não vazar UnhandledRejection)
  const queued = next.catch(err => {
    logger.error(`❌ Erro na fila [${userId}]: ${err.message}`);
  });

  queues[userId] = queued;

  queued.finally(() => {
    if (queues[userId] === queued) delete queues[userId];
  });

  // Retorna a promise original (com rejeição) para o chamador poder tratar
  return next;
}

module.exports = { enqueue };
