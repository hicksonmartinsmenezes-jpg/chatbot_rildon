'use strict';

const { aguardarTarefaComTimeout } = require('../scripts/x2-painel/aguardar-tarefa');

describe('aguardarTarefaComTimeout', () => {
  afterEach(() => jest.useRealTimers());

  test('apos timeout pede cancelamento mas aguarda a tarefa original antes de rejeitar', async () => {
    jest.useFakeTimers();
    let terminarTarefa;
    const tarefa = new Promise((resolve) => { terminarTarefa = resolve; });
    const aoTimeout = jest.fn();
    const criarErroTimeout = () => new Error('timeout');
    const resultado = aguardarTarefaComTimeout(tarefa, {
      timeoutMs: 100,
      aoTimeout,
      criarErroTimeout,
    });
    const rejeicao = expect(resultado).rejects.toThrow('timeout');

    await jest.advanceTimersByTimeAsync(100);
    expect(aoTimeout).toHaveBeenCalledTimes(1);
    let terminou = false;
    resultado.finally(() => { terminou = true; }).catch(() => {});
    await Promise.resolve();
    expect(terminou).toBe(false);

    terminarTarefa();
    await rejeicao;
    expect(terminou).toBe(true);
  });

  test('propaga a falha da tarefa sem esperar o timeout', async () => {
    jest.useFakeTimers();
    const erro = new Error('falha');
    await expect(aguardarTarefaComTimeout(Promise.reject(erro), {
      timeoutMs: 100,
      aoTimeout: jest.fn(),
      criarErroTimeout: () => new Error('timeout'),
    })).rejects.toBe(erro);
  });
});
