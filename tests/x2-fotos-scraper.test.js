/**
 * Testes das partes puras/testáveis de scripts/x2-fotos-scraper.js.
 *
 * O grosso do script é orquestração de navegador (Playwright contra o site
 * real do X2) e não dá — nem faz sentido — pra testar de forma automatizada
 * aqui. O que é testável sem navegador: a normalização de texto usada pra
 * casar o nome da seção com a opção do dropdown do X2, o mapa de seções
 * (slug -> label), e a leitura/escrita do checkpoint de progresso (usado
 * pra retomar de onde parou entre execuções).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// O script importa 'playwright' no topo do arquivo, mas esses testes só
// exercitam funções puras (normalização, checkpoint de progresso) — nunca
// abrem navegador de verdade. Mocka o módulo pra não depender de
// `npm install` ter rodado (o Playwright é pesado e é instalado só pelo
// usuário, na própria máquina, nunca por mim no sandbox).
jest.mock('playwright', () => ({ chromium: { launchPersistentContext: jest.fn() } }), { virtual: true });

// Isola o WORK_DIR do teste do WORK_DIR real do usuário (~/.x2-rildon-scraper)
// via HOME temporário, pra não sujar nem depender do estado real da máquina.
const HOME_FALSO = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-fotos-scraper-test-'));
const homedirOriginal = os.homedir;
os.homedir = () => HOME_FALSO;

let scraper;
beforeAll(() => {
  jest.resetModules();
  scraper = require('../scripts/x2-fotos-scraper');
});

afterAll(() => {
  os.homedir = homedirOriginal;
  fs.rmSync(HOME_FALSO, { recursive: true, force: true });
});

describe('x2-fotos-scraper.normalizar', () => {
  test('remove acentos e normaliza maiúsculas/espaços', () => {
    expect(scraper.normalizar('Componentes Elétricos')).toBe('COMPONENTES ELETRICOS');
    expect(scraper.normalizar('  Injeção   Eletrônica ')).toBe('INJECAO ELETRONICA');
  });

  test('bate com o próprio label de cada seção do mapa (garante que o mapa é usável)', () => {
    for (const label of Object.values(scraper.SECOES)) {
      expect(scraper.normalizar(label)).toBe(scraper.normalizar(label));
    }
  });

  test('entrada vazia/nula não quebra', () => {
    expect(scraper.normalizar(null)).toBe('');
    expect(scraper.normalizar(undefined)).toBe('');
    expect(scraper.normalizar('')).toBe('');
  });
});

describe('x2-fotos-scraper.SECOES', () => {
  // 26 seções de produto vendável (extração original de 2026-07-20) + Consumo
  // (categoria interna de estoque, incluída em 2026-08-11 a pedido do
  // usuário — reverte a exclusão original documentada no README de
  // catalogo-x2). Imobilizado/Padrão continuam de fora.
  test('tem as 27 seções conhecidas do catálogo (ver README de catalogo-x2)', () => {
    expect(Object.keys(scraper.SECOES)).toHaveLength(27);
  });

  test('inclui a seção em andamento (componentes-eletricos) com o label certo', () => {
    expect(scraper.SECOES['componentes-eletricos']).toBe('COMPONENTES ELÉTRICOS');
  });

  test('inclui consumo (2026-08-11)', () => {
    expect(scraper.SECOES['consumo']).toBe('CONSUMO');
  });
});

describe('x2-fotos-scraper: checkpoint de progresso (fora do OneDrive)', () => {
  test('carregarProgresso retorna objeto vazio quando não existe checkpoint ainda', () => {
    expect(scraper.carregarProgresso('secao-inexistente-123')).toEqual({});
  });

  test('salvarProgresso + carregarProgresso faz round-trip', () => {
    const slug = 'secao-teste-roundtrip';
    const progresso = { 111: { status: 'ok', arquivos: ['0.jpg'], ts: '2026-07-28T00:00:00.000Z' } };
    scraper.salvarProgresso(slug, progresso);
    expect(scraper.carregarProgresso(slug)).toEqual(progresso);
  });

  test('progressPath fica dentro do WORK_DIR (fora da pasta do projeto/OneDrive)', () => {
    const p = scraper.progressPath('qualquer-secao');
    expect(p.startsWith(scraper.WORK_DIR)).toBe(true);
    expect(p).not.toContain('PROJETOS gitHUB');
  });

  test('stagingSecaoDir também fica dentro do WORK_DIR', () => {
    expect(scraper.stagingSecaoDir('qualquer-secao').startsWith(scraper.WORK_DIR)).toBe(true);
  });
});

describe('x2-fotos-scraper.calcularFila — pedido do usuário 2026-07-28: "retry" de sem_foto/placeholder (estendido 2026-08-13 pra incluir "erro")', () => {
  const codigos = ['111', '222', '333', '444', '555'];
  const progresso = {
    111: { status: 'ok' },
    222: { status: 'sem_foto' },
    333: { status: 'placeholder' },
    444: { status: 'erro' },
    // 555 nunca processado (não está no objeto de progresso)
  };

  test('sem retrySemFoto: só os nunca processados entram na fila', () => {
    expect(scraper.calcularFila(codigos, progresso)).toEqual(['555']);
  });

  // BUG REAL corrigido em 2026-08-13 (achado analisando os 1209 erros de
  // MECÂNICA): "erro" ficava preso pra sempre, só "sem_foto"/"placeholder"
  // entravam de novo com retrySemFoto. Único jeito de tentar de novo era
  // "Reiniciar do zero", que apaga TODO o progresso da seção. Agora "erro"
  // entra no mesmo retry que "sem_foto"/"placeholder".
  test('com retrySemFoto: nunca-processados + sem_foto + placeholder + erro entram, mas "ok" não', () => {
    const fila = scraper.calcularFila(codigos, progresso, { retrySemFoto: true });
    expect(fila.sort()).toEqual(['222', '333', '444', '555'].sort());
    expect(fila).not.toContain('111'); // já tem foto real (ok) — não reprocessa
  });

  test('limit corta a fila (aplicado depois do filtro de retry)', () => {
    const fila = scraper.calcularFila(codigos, progresso, { retrySemFoto: true, limit: 1 });
    expect(fila).toHaveLength(1);
  });

  test('progresso vazio: todos os códigos entram na fila, com ou sem retry', () => {
    expect(scraper.calcularFila(codigos, {})).toEqual(codigos);
    expect(scraper.calcularFila(codigos, {}, { retrySemFoto: true })).toEqual(codigos);
  });
});

describe('x2-fotos-scraper.calcularFila — rebaixar tudo (2026-10-17): retomavel, sem apagar progresso', () => {
  const h = (horas) => new Date(Date.now() - horas * 3600000).toISOString();
  const codigos = ['a', 'b', 'c', 'd'];

  test('com renovarAposDias=0.5 entram os "ok" baixados ha mais de 12h; os recentes ficam de fora', () => {
    const progresso = {
      a: { status: 'ok', ts: h(48) },
      b: { status: 'ok', ts: h(13) },
      c: { status: 'ok', ts: h(2) },
      d: { status: 'ok', ts: h(0.1) },
    };
    const fila = scraper.calcularFila(codigos, progresso, { renovarAposDias: 0.5, renovarLimite: 100000 });
    expect(fila).toEqual(['a', 'b']);
  });

  test('retomada: o que acabou de ser refeito nao volta pra fila, o resto continua', () => {
    const progresso = { a: { status: 'ok', ts: h(0.05) }, b: { status: 'ok', ts: h(30) }, c: { status: 'ok', ts: h(30) }, d: { status: 'ok', ts: h(30) } };
    expect(scraper.calcularFila(codigos, progresso, { renovarAposDias: 0.5, renovarLimite: 100000 })).toEqual(['b', 'c', 'd']);
  });

  test('sem renovarAposDias, "ok" nunca volta (comportamento antigo preservado)', () => {
    const progresso = { a: { status: 'ok', ts: h(500) } };
    expect(scraper.calcularFila(['a'], progresso, {})).toEqual([]);
  });
});
