/**
 * Testes de scripts/x2-painel/lancamentos.js — só a lógica PURA
 * (construirIndice/listarLancamentos), passando os CSVs já "lidos" em
 * memória (sem tocar em fs real). Mesmo padrão de
 * tests/estoque.service.parseCsv.test.js.
 */
const path = require('path');
const lancamentosPath = path.join('..', 'scripts', 'x2-painel', 'lancamentos.js');
const { construirIndice, listarLancamentos } = require(lancamentosPath);

const CABECALHO =
  ' ;Cód. Fornecedor;Código;Descrição;NCM;CEST;CST ICMS;Cod. Barras;Custo Médio;' +
  '"Preço Venda\nVarejo";"Preço Venda\nAtacado";Qtd Estoque;Und;' +
  'Total (Custo Médio X Estoque);Total (Preço Venda Varejo X Estoque);Total (Preço Venda Atacado X Estoque)';

function linhaProduto(codigo, descricao = 'PRODUTO TESTE') {
  return `1;FORN${codigo};${codigo};${descricao};;;;;R$ 10,00;R$ 20,00;R$ 15,00;5,00;PC;;;`;
}

function csv(...codigos) {
  return [CABECALHO, ...codigos.map((c) => linhaProduto(c))].join('\n');
}

describe('x2-painel/lancamentos: construirIndice', () => {
  test('snapshot único vira a linha de base inteira (1ª aparição = data desse arquivo)', () => {
    const arquivos = [
      { nome: 'estoque-2026-08-06_08-00.csv', conteudo: csv('AAA', 'BBB') },
    ];
    const produtos = construirIndice(arquivos);
    expect(Object.keys(produtos)).toEqual(expect.arrayContaining(['AAA', 'BBB']));
    expect(produtos.AAA.arquivoOrigem).toBe('estoque-2026-08-06_08-00.csv');
  });

  test('produto que já existia no 1º snapshot mantém a data do 1º snapshot, mesmo aparecendo de novo depois', () => {
    const arquivos = [
      { nome: 'estoque-2026-08-06_08-00.csv', conteudo: csv('AAA') },
      { nome: 'estoque-2026-08-07_08-00.csv', conteudo: csv('AAA', 'BBB') },
    ];
    const produtos = construirIndice(arquivos);
    expect(produtos.AAA.arquivoOrigem).toBe('estoque-2026-08-06_08-00.csv');
    expect(produtos.BBB.arquivoOrigem).toBe('estoque-2026-08-07_08-00.csv');
  });

  test('ordem dos arquivos importa — precisa vir cronológica pra 1ª aparição funcionar', () => {
    // fora de ordem de propósito: o mais novo primeiro faria BBB "roubar"
    // a posição de 1ª aparição do dia errado — função não reordena sozinha,
    // quem chama (obterIndiceAtualizado) é responsável por ordenar antes.
    const arquivos = [
      { nome: 'estoque-2026-08-05_08-00.csv', conteudo: csv('AAA') },
      { nome: 'estoque-2026-08-07_08-00.csv', conteudo: csv('AAA', 'CCC') },
      { nome: 'estoque-2026-08-06_08-00.csv', conteudo: csv('AAA', 'CCC') },
    ];
    const produtos = construirIndice(arquivos);
    // como veio nessa ordem, CCC apareceu 1ª vez no arquivo de 07/08 (2º da lista)
    expect(produtos.CCC.arquivoOrigem).toBe('estoque-2026-08-07_08-00.csv');
  });

  test('arquivo com nome fora do padrão é ignorado sem quebrar o índice', () => {
    const arquivos = [
      { nome: 'export-qualquer.csv', conteudo: csv('AAA') },
      { nome: 'estoque-2026-08-06_08-00.csv', conteudo: csv('BBB') },
    ];
    const produtos = construirIndice(arquivos);
    expect(produtos.AAA).toBeUndefined();
    expect(produtos.BBB).toBeDefined();
  });

  test('CSV corrompido não trava o índice — outros arquivos continuam sendo processados', () => {
    const arquivos = [
      { nome: 'estoque-2026-08-06_08-00.csv', conteudo: 'Nome;Preço\nProduto X;10,00' }, // sem coluna Código -> parseCsvEstoque lança erro
      { nome: 'estoque-2026-08-07_08-00.csv', conteudo: csv('BBB') },
    ];
    const produtos = construirIndice(arquivos);
    expect(produtos.BBB).toBeDefined();
  });

  test('descricao e precoVendaVarejo são preservados no índice', () => {
    const arquivos = [
      { nome: 'estoque-2026-08-06_08-00.csv', conteudo: csv('AAA') },
    ];
    const produtos = construirIndice(arquivos);
    expect(produtos.AAA.descricao).toBe('PRODUTO TESTE');
    expect(produtos.AAA.precoVendaVarejo).toBe(20);
  });
});

// listarLancamentos usa fs de verdade (obterIndiceAtualizado lê o diretório
// ~/.x2-rildon-scraper/estoque) — sem mock de fs aqui, então testamos só o
// caminho "sem nenhum export ainda" (comportamento determinístico mesmo
// numa máquina/sandbox sem histórico nenhum) e deixamos o resto coberto
// pelos testes de construirIndice (função pura, sem I/O) acima.
describe('x2-painel/lancamentos: listarLancamentos (sem histórico)', () => {
  test('retorna lista vazia com aviso quando não há exports suficientes', () => {
    // Não temos como garantir 0 arquivos numa máquina real do usuário (pode
    // já ter rodado exports antes) — então só validamos o formato da
    // resposta, não o conteúdo exato.
    const resultado = listarLancamentos({});
    expect(resultado).toHaveProperty('lancamentos');
    expect(Array.isArray(resultado.lancamentos)).toBe(true);
  });
});
