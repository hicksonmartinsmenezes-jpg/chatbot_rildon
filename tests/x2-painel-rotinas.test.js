/**
 * Testes de scripts/x2-painel/rotinas.js — armazenamento de rotinas + regras
 * de "quando rodar" (deveRodarAgora/proximaExecucao). Tudo puro (recebe
 * `agora` como parâmetro), sem navegador/Playwright envolvido.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_FALSO = fs.mkdtempSync(path.join(os.tmpdir(), 'x2-painel-rotinas-test-'));
const homedirOriginal = os.homedir;
os.homedir = () => HOME_FALSO;

const rotinas = require('../scripts/x2-painel/rotinas');

afterAll(() => {
  os.homedir = homedirOriginal;
  fs.rmSync(HOME_FALSO, { recursive: true, force: true });
});

afterEach(() => {
  // isola cada teste — apaga rotinas.json entre testes
  if (fs.existsSync(rotinas.ROTINAS_PATH)) fs.rmSync(rotinas.ROTINAS_PATH);
});

const rotinaBase = {
  nome: 'Baixar fotos gerador',
  tipo: 'baixar',
  secoes: ['gerador'],
  frequencia: 'diaria',
  horario: '22:00',
};

describe('rotinas: validação', () => {
  test('rotina válida (diária) não gera erro', () => {
    expect(rotinas.validarRotina(rotinaBase)).toEqual([]);
  });

  test('tipo inválido é rejeitado', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, tipo: 'zip' })).toContain('tipo precisa ser "baixar", "sync", "estoque" ou "painel-produtos".');
  });

  test('tipo painel-produtos não exige secoes', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, tipo: 'painel-produtos', secoes: undefined })).toEqual([]);
  });

  test('secoes vazia é rejeitada (tipo baixar/sync)', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, secoes: [] }).length).toBeGreaterThan(0);
  });

  test('tipo estoque não exige secoes', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, tipo: 'estoque', secoes: undefined })).toEqual([]);
  });

  test('horario fora do formato HH:MM é rejeitado', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, horario: '22h' }).length).toBeGreaterThan(0);
  });

  test('semanal sem diaSemana é rejeitada', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, frequencia: 'semanal' }).length).toBeGreaterThan(0);
  });

  test('semanal com diaSemana válido passa', () => {
    expect(rotinas.validarRotina({ ...rotinaBase, frequencia: 'semanal', diaSemana: 0 })).toEqual([]);
  });
});

describe('rotinas: CRUD (round-trip em disco, fora do OneDrive)', () => {
  test('criarRotina + carregarRotinas faz round-trip', () => {
    const criada = rotinas.criarRotina(rotinaBase);
    expect(criada.id).toBeTruthy();
    expect(criada.ativa).toBe(true);
    expect(criada.ultimaExecucao).toBeNull();
    const lista = rotinas.carregarRotinas();
    expect(lista).toHaveLength(1);
    expect(lista[0].nome).toBe('Baixar fotos gerador');
  });

  test('criarRotina com dados inválidos lança erro com status 400', () => {
    expect(() => rotinas.criarRotina({ ...rotinaBase, tipo: 'lixo' })).toThrow();
    try {
      rotinas.criarRotina({ ...rotinaBase, tipo: 'lixo' });
    } catch (e) {
      expect(e.status).toBe(400);
    }
  });

  test('atualizarRotina (PATCH parcial) só ativa/desativa sem exigir o resto', () => {
    const criada = rotinas.criarRotina(rotinaBase);
    const atualizada = rotinas.atualizarRotina(criada.id, { ativa: false });
    expect(atualizada.ativa).toBe(false);
    expect(atualizada.horario).toBe('22:00'); // resto preservado
  });

  test('atualizarRotina com id inexistente lança 404', () => {
    expect(() => rotinas.atualizarRotina('id-fantasma', { ativa: false })).toThrow();
  });

  test('removerRotina remove de fato', () => {
    const criada = rotinas.criarRotina(rotinaBase);
    rotinas.removerRotina(criada.id);
    expect(rotinas.carregarRotinas()).toHaveLength(0);
  });

  test('registrarExecucao grava ultimaExecucao/ultimoResultado/ultimoErro', () => {
    const criada = rotinas.criarRotina(rotinaBase);
    rotinas.registrarExecucao(criada.id, { resultado: 'erro', erro: 'X2 fora do ar' });
    const [atualizada] = rotinas.carregarRotinas();
    expect(atualizada.ultimoResultado).toBe('erro');
    expect(atualizada.ultimoErro).toBe('X2 fora do ar');
    expect(atualizada.ultimaExecucao).toBeTruthy();
  });
});

describe('rotinas: deveRodarAgora', () => {
  test('rotina inativa nunca deve rodar', () => {
    const r = { ...rotinaBase, ativa: false, ultimaExecucao: null };
    expect(rotinas.deveRodarAgora(r, new Date('2026-08-06T23:00:00'))).toBe(false);
  });

  test('diária: antes do horário configurado não deve rodar', () => {
    const r = { ...rotinaBase, ativa: true, ultimaExecucao: null };
    expect(rotinas.deveRodarAgora(r, new Date('2026-08-06T21:00:00'))).toBe(false);
  });

  test('diária: depois do horário e nunca rodou, deve rodar', () => {
    const r = { ...rotinaBase, ativa: true, ultimaExecucao: null };
    expect(rotinas.deveRodarAgora(r, new Date('2026-08-06T22:05:00'))).toBe(true);
  });

  test('diária: depois do horário mas já rodou hoje depois desse horário, não roda de novo', () => {
    const r = { ...rotinaBase, ativa: true, ultimaExecucao: new Date('2026-08-06T22:01:00').toISOString() };
    expect(rotinas.deveRodarAgora(r, new Date('2026-08-06T23:00:00'))).toBe(false);
  });

  test('diária: rodou ONTEM (antes do horário de hoje) — deve rodar hoje de novo', () => {
    const r = { ...rotinaBase, ativa: true, ultimaExecucao: new Date('2026-08-05T22:01:00').toISOString() };
    expect(rotinas.deveRodarAgora(r, new Date('2026-08-06T22:05:00'))).toBe(true);
  });

  test('semanal: só roda no dia da semana certo', () => {
    const r = { ...rotinaBase, frequencia: 'semanal', diaSemana: 0, ativa: true, ultimaExecucao: null }; // domingo
    const quintaFeira = new Date('2026-08-06T23:00:00'); // 2026-08-06 é quinta
    expect(rotinas.deveRodarAgora(r, quintaFeira)).toBe(false);
    const domingo = new Date('2026-08-09T22:05:00');
    expect(rotinas.deveRodarAgora(r, domingo)).toBe(true);
  });
});

describe('rotinas: proximaExecucao', () => {
  test('diária, ainda não passou do horário hoje: próxima é hoje', () => {
    const r = { ...rotinaBase };
    const agora = new Date('2026-08-06T10:00:00');
    const prox = rotinas.proximaExecucao(r, agora);
    expect(prox.getDate()).toBe(agora.getDate());
  });

  test('diária, já passou do horário hoje: próxima é amanhã', () => {
    const r = { ...rotinaBase };
    const agora = new Date('2026-08-06T23:00:00');
    const prox = rotinas.proximaExecucao(r, agora);
    expect(prox.getDate()).toBe(agora.getDate() + 1);
  });

  test('semanal: calcula o próximo dia da semana certo', () => {
    const r = { ...rotinaBase, frequencia: 'semanal', diaSemana: 0 }; // domingo
    const quintaFeira = new Date('2026-08-06T10:00:00');
    const prox = rotinas.proximaExecucao(r, quintaFeira);
    expect(prox.getDay()).toBe(0);
    expect(prox > quintaFeira).toBe(true);
  });
});
