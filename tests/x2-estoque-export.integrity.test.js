const fs = require('fs');
const os = require('os');
const path = require('path');
const { validarCompletudeCsv, nomeArquivoExecucao, executarComLockArquivo, executarComLockComEspera } = require('../scripts/x2-estoque-export');

describe('integridade do CSV de estoque', () => {
  const parseValido = (csv) => csv.split(/\r?\n/).filter(Boolean).slice(1).map((linha) => ({ linha }));

  test('aceita CSV completo em relaÃ§Ã£o Ã  tabela estÃ¡vel', () => {
    const csv = 'cabecalho\na\nb\nc';
    expect(validarCompletudeCsv(csv, 4, parseValido)).toMatchObject({
      valido: true, linhasCsv: 3, linhasTabela: 3, motivo: null,
    });
  });

  test('recusa CSV truncado abaixo do limiar de 90%', () => {
    const csv = 'cabecalho\na\nb';
    expect(validarCompletudeCsv(csv, 11, parseValido)).toMatchObject({
      valido: false, linhasCsv: 2, linhasTabela: 10,
    });
  });

  test('recusa tabela vazia ou sem linhas mensurÃ¡veis', () => {
    expect(validarCompletudeCsv('cabecalho', 1, parseValido).valido).toBe(false);
    expect(validarCompletudeCsv('cabecalho\na', -1, parseValido).valido).toBe(false);
  });

  test('recusa CSV com linhas textuais mas poucos registros parseÃ¡veis', () => {
    const csv = 'cabecalho\na\nb\nc';
    expect(validarCompletudeCsv(csv, 4, () => [])).toMatchObject({
      valido: false, motivo: 'CSV has no parseable records',
    });
  });

  test('gera nomes distintos por execução mesmo no mesmo minuto', () => {
    const nome = 'estoque-2026-10-14_12-30.csv';
    expect(nomeArquivoExecucao(nome, 'exec-a')).not.toBe(nomeArquivoExecucao(nome, 'exec-b'));
    expect(nomeArquivoExecucao(nome, 'exec-a')).toBe('estoque-2026-10-14_12-30-exec-a.csv');
  });

  test('conta registros lógicos parseados, não quebras físicas dentro de campos quoted', () => {
    const csv = 'header\n"descrição com\nquebra";1\nproduto;2';
    expect(validarCompletudeCsv(csv, 3, () => [{}, {}])).toMatchObject({
      valido: true, linhasCsv: 2, linhasTabela: 2,
    });
  });

  test('lock impede segunda cópia/importação enquanto a primeira está ativa', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-lock-'));
    const lock = path.join(dir, 'import.lock');
    let liberar;
    let primeiraOperacaoTerminou = false;
    try {
      const primeira = executarComLockArquivo(lock, () => new Promise((resolve) => { liberar = resolve; }))
        .then((resultado) => { primeiraOperacaoTerminou = true; return resultado; });
      await new Promise((resolve) => setImmediate(resolve));
      const segundaAcao = jest.fn();
      const segunda = await executarComLockArquivo(lock, segundaAcao);
      expect(segunda).toEqual({ acquired: false });
      expect(segundaAcao).not.toHaveBeenCalled();
      expect(primeiraOperacaoTerminou).toBe(false);
      liberar();
      expect(await primeira).toEqual({ acquired: true });
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recupera lock antigo somente quando o PID registrado não existe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-lock-stale-'));
    const lock = path.join(dir, 'import.lock');
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, adquiridoEm: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
      const operacao = jest.fn();
      expect(await executarComLockArquivo(lock, operacao)).toEqual({ acquired: true });
      expect(operacao).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(`${lock}.recovery`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recupera também um .recovery órfão com PID morto e idade suficiente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-recovery-stale-'));
    const lock = path.join(dir, 'import.lock');
    const antigo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, adquiridoEm: antigo }));
      fs.writeFileSync(`${lock}.recovery`, JSON.stringify({ pid: 2147483647, adquiridoEm: antigo }));
      const operacao = jest.fn();
      expect(await executarComLockArquivo(lock, operacao)).toEqual({ acquired: true });
      expect(operacao).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(`${lock}.recovery`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('não remove .recovery ativo e retry termina com pendência explícita', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-recovery-active-'));
    const lock = path.join(dir, 'import.lock');
    try {
      const agora = new Date().toISOString();
      fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647, adquiridoEm: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
      fs.writeFileSync(`${lock}.recovery`, JSON.stringify({ pid: process.pid, adquiridoEm: agora }));
      const operacao = jest.fn();
      const resultado = await executarComLockComEspera(lock, operacao, { maxWaitMs: 0, intervaloMs: 1 });
      expect(resultado).toMatchObject({ acquired: false, expirou: true });
      expect(operacao).not.toHaveBeenCalled();
      expect(fs.existsSync(`${lock}.recovery`)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('retry adquire lock liberado dentro da janela de espera', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estoque-lock-retry-'));
    const lock = path.join(dir, 'import.lock');
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, adquiridoEm: new Date().toISOString() }));
      let esperas = 0;
      const operacao = jest.fn();
      const resultado = await executarComLockComEspera(lock, operacao, {
        maxWaitMs: 100,
        intervaloMs: 1,
        aguardar: async () => { esperas += 1; fs.unlinkSync(lock); },
      });
      expect(resultado).toEqual({ acquired: true });
      expect(esperas).toBe(1);
      expect(operacao).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
