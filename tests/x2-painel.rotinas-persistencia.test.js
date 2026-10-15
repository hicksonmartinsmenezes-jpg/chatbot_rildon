'use strict';

/**
 * Regressão do BUG DE PERDA DE DADOS encontrado na auditoria de 2026-10-14.
 *
 * A cadeia original, reproduzida ao vivo antes da correção:
 *   1) salvarRotinas gravava com fs.writeFileSync direto, que TRUNCA e depois
 *      escreve — uma queda no meio deixava um JSON cortado;
 *   2) carregarRotinas tinha `catch { return [] }`, então o JSON cortado virava
 *      silenciosamente "nenhuma rotina cadastrada";
 *   3) a criação/edição seguinte carregava [], acrescentava o item novo e
 *      gravava em cima — apagando de verdade as rotinas que ainda estavam no
 *      arquivo cortado.
 *
 * O que estes testes travam: gravação atômica (sem estado meio-escrito e sem
 * sobra de temporário) e falha ruidosa que PRESERVA o arquivo ilegível em vez
 * de tratá-lo como lista vazia.
 */

const fs = require('fs');
const path = require('path');

// WORK_DIR do módulo é calculado no require, a partir de os.homedir() — então
// o desvio tem que estar de pé ANTES de carregar o módulo, para o teste nunca
// tocar no ~/.x2-rildon-scraper real de quem roda a suíte.
//
// Mexer em process.env.HOME NÃO serve aqui: dentro do Jest, process.env é uma
// cópia do sandbox, enquanto os.homedir() lê o ambiente real do processo no
// C++ (uv_os_homedir) — a atribuição simplesmente não chega lá. Por isso o
// desvio é um mock de os.homedir(). O prefixo "mock" no nome da variável é
// exigido pelo Jest para a fábrica poder referenciá-la.
const mockDiretorioTeste = fs.mkdtempSync(path.join(jest.requireActual('os').tmpdir(), 'rotinas-persistencia-'));

jest.mock('os', () => ({ ...jest.requireActual('os'), homedir: () => mockDiretorioTeste }));

const rotinas = require('../scripts/x2-painel/rotinas');

const PASTA = path.join(mockDiretorioTeste, '.x2-rildon-scraper');
const ARQUIVO = path.join(PASTA, 'rotinas.json');

const TRES_ROTINAS = [
  { id: 'r1', nome: 'Lançamentos da Semana', tipo: 'lancamentos-x2', frequencia: 'semanal', diaSemana: 1, horario: '07:50', secoes: [], opcoes: {}, ativa: true },
  { id: 'r2', nome: 'Atualização de Estoque/Preço', tipo: 'estoque', frequencia: 'horas', intervaloHoras: 5, horario: null, secoes: [], opcoes: {}, ativa: true },
  { id: 'r3', nome: 'Fotos da noite', tipo: 'baixar', frequencia: 'diaria', horario: '23:00', secoes: ['mecanica'], opcoes: {}, ativa: true },
];

function arquivosNaPasta() {
  return fs.existsSync(PASTA) ? fs.readdirSync(PASTA).sort() : [];
}

function limparPasta() {
  for (const nome of arquivosNaPasta()) fs.rmSync(path.join(PASTA, nome), { force: true });
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  fs.mkdirSync(PASTA, { recursive: true });
  limparPasta();
});

afterEach(() => {
  console.error.mockRestore();
});

afterAll(() => {
  fs.rmSync(mockDiretorioTeste, { recursive: true, force: true });
});

describe('persistência das rotinas do painel X2', () => {
  test('salvarRotinas grava o conteúdo completo e não deixa arquivo temporário para trás', () => {
    rotinas.salvarRotinas(TRES_ROTINAS);

    expect(arquivosNaPasta()).toEqual(['rotinas.json']);
    expect(rotinas.carregarRotinas()).toHaveLength(3);
    // Se o rename atômico fosse trocado por um writeFileSync direto, este teste
    // continuaria passando — o que ele trava de verdade é a ausência de sobra
    // de `.tmp-`, que é o sinal observável de que a gravação é em dois passos.
    expect(arquivosNaPasta().some((n) => n.includes('.tmp-'))).toBe(false);
  });

  test('arquivo truncado NÃO é tratado como lista vazia: é preservado com outro nome', () => {
    rotinas.salvarRotinas(TRES_ROTINAS);
    const conteudo = fs.readFileSync(ARQUIVO, 'utf8');
    // Queda no meio da gravação: JSON cortado.
    fs.writeFileSync(ARQUIVO, conteudo.slice(0, Math.floor(conteudo.length * 0.6)));

    expect(rotinas.carregarRotinas()).toEqual([]);

    const preservados = arquivosNaPasta().filter((n) => n.includes('.corrompido-'));
    expect(preservados).toHaveLength(1);
    // O original saiu da frente, então a gravação seguinte não sobrescreve nada.
    expect(fs.existsSync(ARQUIVO)).toBe(false);
    // E o conteúdo cortado continua lá, recuperável à mão.
    expect(fs.readFileSync(path.join(PASTA, preservados[0]), 'utf8')).toContain('Lançamentos da Semana');
    expect(console.error).toHaveBeenCalled();
  });

  test('JSON válido que não é lista (ex: {}) também conta como corrompido', () => {
    fs.writeFileSync(ARQUIVO, '{}');

    expect(rotinas.carregarRotinas()).toEqual([]);
    expect(arquivosNaPasta().filter((n) => n.includes('.corrompido-'))).toHaveLength(1);
  });

  test('criar uma rotina depois de uma corrupção não destrói a configuração anterior', () => {
    rotinas.salvarRotinas(TRES_ROTINAS);
    const conteudo = fs.readFileSync(ARQUIVO, 'utf8');
    fs.writeFileSync(ARQUIVO, conteudo.slice(0, Math.floor(conteudo.length * 0.6)));

    // Era exatamente aqui que as 3 rotinas morriam: carregarRotinas devolvia
    // [] e este salvar gravava em cima do arquivo cortado.
    rotinas.criarRotina({ nome: 'Rotina nova', tipo: 'estoque', frequencia: 'horas', intervaloHoras: 5 });

    expect(rotinas.carregarRotinas().map((r) => r.nome)).toEqual(['Rotina nova']);
    // As 3 originais continuam no disco, no arquivo preservado.
    const preservado = arquivosNaPasta().find((n) => n.includes('.corrompido-'));
    expect(preservado).toBeDefined();
    const salvo = fs.readFileSync(path.join(PASTA, preservado), 'utf8');
    expect(salvo).toContain('Lançamentos da Semana');
    expect(salvo).toContain('Atualização de Estoque/Preço');
  });

  test('pasta ainda inexistente devolve lista vazia sem criar nada estranho', () => {
    fs.rmSync(PASTA, { recursive: true, force: true });

    expect(rotinas.carregarRotinas()).toEqual([]);
    expect(arquivosNaPasta()).toEqual([]);
  });
});
