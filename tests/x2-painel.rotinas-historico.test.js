'use strict';

/**
 * Histórico de execuções por rotina (sessão de testes de 2026-10-17).
 *
 * Antes só existia o ÚLTIMO resultado de cada rotina. Com isso o painel
 * contava "execuções hoje" por ROTINA e não por execução: a rotina de
 * estoque roda a cada 5h (~4x/dia) e aparecia como "1 execução hoje, 1
 * falha"; e uma falha da madrugada sumia da tela assim que a execução
 * seguinte dava certo — exatamente o que a equipe precisa enxergar para
 * confiar que o catálogo está sendo atualizado sozinho.
 *
 * O que estes testes travam: cada execução registrada entra no histórico,
 * da mais recente pra mais antiga, com o erro preservado, e a lista não
 * cresce sem limite.
 */

const fs = require('fs');
const path = require('path');

const mockDiretorioTeste = fs.mkdtempSync(path.join(jest.requireActual('os').tmpdir(), 'rotinas-historico-'));
jest.mock('os', () => ({ ...jest.requireActual('os'), homedir: () => mockDiretorioTeste }));

const rotinas = require('../scripts/x2-painel/rotinas');

function novaRotina() {
  return rotinas.criarRotina({ nome: 'Estoque', tipo: 'estoque', frequencia: 'horas', intervaloHoras: 5 });
}

describe('histórico de execuções da rotina', () => {
  beforeEach(() => {
    try { fs.unlinkSync(rotinas.ROTINAS_PATH); } catch { /* primeiro teste */ }
  });

  test('guarda uma entrada por execução, da mais recente pra mais antiga', () => {
    const r = novaRotina();
    rotinas.registrarExecucao(r.id, { resultado: 'sucesso' });
    rotinas.registrarExecucao(r.id, { resultado: 'erro', erro: 'Menu "Logística" não apareceu' });

    const salva = rotinas.carregarRotinas().find((x) => x.id === r.id);
    expect(salva.historico).toHaveLength(2);
    expect(salva.historico[0].resultado).toBe('erro');
    expect(salva.historico[0].erro).toContain('Logística');
    expect(salva.historico[1].resultado).toBe('sucesso');
    // O campo antigo continua válido — o painel ainda lê os dois.
    expect(salva.ultimoResultado).toBe('erro');
  });

  test('duas execuções no mesmo dia contam como duas, não como uma rotina', () => {
    const r = novaRotina();
    rotinas.registrarExecucao(r.id, { resultado: 'erro', erro: 'falhou 1' });
    rotinas.registrarExecucao(r.id, { resultado: 'erro', erro: 'falhou 2' });
    rotinas.registrarExecucao(r.id, { resultado: 'sucesso' });

    const salva = rotinas.carregarRotinas().find((x) => x.id === r.id);
    const hoje = new Date().toDateString();
    const doDia = salva.historico.filter((e) => new Date(e.em).toDateString() === hoje);
    expect(doDia).toHaveLength(3);
    expect(doDia.filter((e) => e.resultado === 'erro')).toHaveLength(2);
  });

  test('não cresce sem limite', () => {
    const r = novaRotina();
    for (let i = 0; i < 60; i += 1) rotinas.registrarExecucao(r.id, { resultado: 'sucesso' });
    const salva = rotinas.carregarRotinas().find((x) => x.id === r.id);
    expect(salva.historico.length).toBeLessThanOrEqual(40);
  });

  test('erro muito longo é cortado antes de ir pro disco', () => {
    const r = novaRotina();
    rotinas.registrarExecucao(r.id, { resultado: 'erro', erro: 'x'.repeat(5000) });
    const salva = rotinas.carregarRotinas().find((x) => x.id === r.id);
    expect(salva.historico[0].erro.length).toBeLessThanOrEqual(300);
  });
});
