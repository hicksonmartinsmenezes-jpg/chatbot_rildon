'use strict';

/**
 * Espera a tarefa e, se o prazo vencer, pede cancelamento cooperativo e
 * continua esperando a Promise original. Promise.race sozinha nao encerra
 * Playwright e nao deve liberar o lock enquanto ele ainda estiver ativo.
 */
function aguardarTarefaComTimeout(tarefa, { timeoutMs, aoTimeout, criarErroTimeout }) {
  let timeoutId;
  let expirou = false;
  const prazo = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      expirou = true;
      aoTimeout();
      reject(criarErroTimeout());
    }, timeoutMs);
  });

  return Promise.race([tarefa, prazo])
    .catch(async (erro) => {
      if (expirou) await tarefa.catch(() => {});
      throw erro;
    })
    .finally(() => clearTimeout(timeoutId));
}

module.exports = { aguardarTarefaComTimeout };
