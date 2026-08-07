/**
 * Testes de estoque.service.js — só a parte PURA (parseCsvEstoque), sem
 * banco. importarCsv/carregarEstoque precisam de Postgres real (fora do
 * sandbox de testes, ver memória "Limitações do sandbox pra rodar testes
 * do bot Rildon") — não cobertos aqui.
 */
const { parseCsvEstoque } = require('../src/services/estoque.service');

const CABECALHO =
  ' ;Cód. Fornecedor;Código;Descrição;NCM;CEST;CST ICMS;Cod. Barras;Custo Médio;' +
  '"Preço Venda\nVarejo";"Preço Venda\nAtacado";Qtd Estoque;Und;' +
  'Total (Custo Médio X Estoque);Total (Preço Venda Varejo X Estoque);Total (Preço Venda Atacado X Estoque)';

function csvComLinhas(...linhas) {
  return [CABECALHO, ...linhas].join('\n');
}

describe('estoque.service: parseCsvEstoque', () => {
  test('parseia uma linha real do Relatório de Estoque', () => {
    const csv = csvComLinhas(
      '1;TK4000;116564;4000 130MM 12V 60/55W FAROL - POLO - TK 4000;8539.10.10;0107000;260;7898942080371;R$ 27,84;R$ 64,53;R$ 46,22;10,00;PC;R$ 278,40;R$ 645,30;R$ 462,20'
    );
    const [reg] = parseCsvEstoque(csv);
    expect(reg).toEqual({
      codigo: '116564',
      codFornecedor: 'TK4000',
      descricao: '4000 130MM 12V 60/55W FAROL - POLO - TK 4000',
      qtdEstoque: 10,
      unidade: 'PC',
      custoMedio: 27.84,
      precoVendaVarejo: 64.53,
      precoVendaAtacado: 46.22,
    });
  });

  test('valor com milhar (ponto) e decimal (vírgula) — "2.947,00"', () => {
    const csv = csvComLinhas(
      '1;FK1324;122443;ABRAC NYLON PRETA;3926.90.90;1301600;060;123;R$ 0,05;R$ 0,14;R$ 0,11;2.947,00;UN;R$ 147,35;R$ 412,58;R$ 324,17'
    );
    const [reg] = parseCsvEstoque(csv);
    expect(reg.qtdEstoque).toBe(2947);
  });

  test('linha sem código é ignorada', () => {
    const csv = csvComLinhas(
      '1;;;;;;;;;;;;;;;',
      '2;TK4000;116564;produto valido;;;;;;;;10,00;PC;;;'
    );
    const regs = parseCsvEstoque(csv);
    expect(regs).toHaveLength(1);
    expect(regs[0].codigo).toBe('116564');
  });

  test('CSV só com cabeçalho retorna lista vazia', () => {
    expect(parseCsvEstoque(CABECALHO)).toEqual([]);
  });

  test('CSV vazio retorna lista vazia', () => {
    expect(parseCsvEstoque('')).toEqual([]);
  });

  test('cabeçalho sem coluna Código/Qtd Estoque lança erro claro', () => {
    const csvQuebrado = 'Nome;Preço\nProduto X;10,00';
    expect(() => parseCsvEstoque(csvQuebrado)).toThrow(/não tem as colunas esperadas/);
  });

  test('BOM no início do arquivo não quebra o parsing', () => {
    const csv = '﻿' + csvComLinhas(
      '1;TK4000;116564;produto;;;;;;;;5,00;PC;;;'
    );
    const regs = parseCsvEstoque(csv);
    expect(regs).toHaveLength(1);
    expect(regs[0].qtdEstoque).toBe(5);
  });
});
