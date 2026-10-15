/**
 * Testes de scripts/x2-painel/qualidade-apenas-cadastrados.js — só a lógica
 * PURA (calcularApenasCadastradosDeConteudo), passando o CSV já "lido" em
 * memória (sem tocar em fs real). Mesmo padrão de
 * tests/estoque.service.parseCsv.test.js e tests/x2-painel.lancamentos.test.js.
 */
const path = require('path');
const modPath = path.join('..', 'scripts', 'x2-painel', 'qualidade-apenas-cadastrados.js');
const { CHAVE, LABEL_BADGE, calcularApenasCadastradosDeConteudo, metaDeExportCompleto } = require(modPath);

const CABECALHO =
  ' ;Cód. Fornecedor;Código;Descrição;NCM;CEST;CST ICMS;Cod. Barras;Custo Médio;' +
  '"Preço Venda\nVarejo";"Preço Venda\nAtacado";Qtd Estoque;Und;' +
  'Total (Custo Médio X Estoque);Total (Preço Venda Varejo X Estoque);Total (Preço Venda Atacado X Estoque)';

// campos: codigo, descricao, custoMedio, varejo, atacado, qtdEstoque
function linha({ codigo, descricao = 'PRODUTO TESTE', custoMedio = 'R$ 10,00', varejo = 'R$ 20,00', atacado = 'R$ 15,00', qtd = '5,00' }) {
  return `1;FORN${codigo};${codigo};${descricao};;;;;${custoMedio};${varejo};${atacado};${qtd};PC;;;`;
}

function csv(...linhas) {
  return [CABECALHO, ...linhas.map(linha)].join('\n');
}

describe('x2-painel/qualidade-apenas-cadastrados', () => {
  test('produto sem estoque (0) e sem preço varejo (0) entra na lista', () => {
    const conteudo = csv({ codigo: 'AAA', qtd: '0,00', varejo: '' });
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'estoque-teste.csv', capturadoEm: '2026-08-07T10:00:00.000Z' });
    expect(resultado.produtos.map((p) => p[0])).toEqual(['AAA']);
  });

  test('produto COM estoque e sem preço NÃO entra (só zero+zero conta)', () => {
    const conteudo = csv({ codigo: 'BBB', qtd: '3,00', varejo: '' });
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'x', capturadoEm: 'x' });
    expect(resultado.produtos).toHaveLength(0);
  });

  test('produto sem estoque mas COM preço NÃO entra', () => {
    const conteudo = csv({ codigo: 'CCC', qtd: '0,00', varejo: 'R$ 25,00' });
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'x', capturadoEm: 'x' });
    expect(resultado.produtos).toHaveLength(0);
  });

  test('produto com estoque e preço normais NÃO entra', () => {
    const conteudo = csv({ codigo: 'DDD', qtd: '5,00', varejo: 'R$ 20,00' });
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'x', capturadoEm: 'x' });
    expect(resultado.produtos).toHaveLength(0);
  });

  test('mistura de produtos — só os "zero+zero" entram, mantendo ordem do CSV', () => {
    const conteudo = csv(
      { codigo: 'AAA', qtd: '0,00', varejo: '' },
      { codigo: 'BBB', qtd: '5,00', varejo: 'R$ 20,00' },
      { codigo: 'CCC', qtd: '0,00', varejo: 'R$ 0,00' },
      { codigo: 'DDD', qtd: '2,00', varejo: '' }
    );
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'x', capturadoEm: 'x' });
    expect(resultado.produtos.map((p) => p[0])).toEqual(['AAA', 'CCC']);
  });

  test('metadados (chave, labelBadge, headers, origem/capturadoEm) vêm certos', () => {
    const conteudo = csv({ codigo: 'AAA', qtd: '0,00', varejo: '' });
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'estoque-2026-08-07_09-00.csv', capturadoEm: '2026-08-07T09:00:00.000Z' });
    expect(resultado.chave).toBe(CHAVE);
    expect(resultado.chave).toBe('apenasCadastrados');
    expect(resultado.labelBadge).toBe(LABEL_BADGE);
    expect(resultado.labelBadge).toBe('Apenas Cadastrados');
    expect(resultado.headers).toEqual(['Código', 'Cód. Fornecedor', 'Descrição', 'Qtd Estoque', 'Preço Venda Varejo', 'Custo Médio']);
    expect(resultado.origemArquivo).toBe('estoque-2026-08-07_09-00.csv');
    expect(resultado.capturadoEm).toBe('2026-08-07T09:00:00.000Z');
  });

  test('linha completa (código, cód. fornecedor, descrição, qtd, preço, custo) vem formatada certo', () => {
    const conteudo = csv({ codigo: 'XYZ', descricao: 'PARAFUSO SEXTAVADO', qtd: '0,00', varejo: '', custoMedio: 'R$ 3,50' });
    const resultado = calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: 'x', capturadoEm: 'x' });
    expect(resultado.produtos[0]).toEqual(['XYZ', 'FORNXYZ', 'PARAFUSO SEXTAVADO', '0', '0', '3.5']);
  });

  test('CSV vazio (só cabeçalho) retorna lista vazia sem quebrar', () => {
    const resultado = calcularApenasCadastradosDeConteudo(CABECALHO, { origemArquivo: 'x', capturadoEm: 'x' });
    expect(resultado.produtos).toEqual([]);
  });

  test('fonte verificada exige sidecar de export full e não aceita legado ausente', () => {
    const meta = { validado: true, completo: true, estoqueOpcao: 'Com e sem estoque', capturadoEm: '2026-10-14T12:00:00.123Z', linhasCsv: 100, linhasTabela: 100 };
    expect(metaDeExportCompleto(undefined)).toBe(false);
    expect(metaDeExportCompleto({ ...meta, completo: false })).toBe(false);
    expect(metaDeExportCompleto({ ...meta, estoqueOpcao: 'Apenas com estoque' })).toBe(false);
    expect(metaDeExportCompleto(meta)).toBe(true);
  });
});
