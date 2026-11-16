// Issue #29 — estoque por unidade: produto 123983 tem 0 na Matriz, 13 na Distribuidora e 0 no
// Ecommerce (X2, 16/11/2026). O total precisa ser 13 e o detalhe/preço da DIST ficar acessível.
jest.mock('../src/database/postgres', () => ({ query: jest.fn(), connect: jest.fn() }));
const { combinarUnidades, normalizarEmpresa, EMPRESAS } = require('../src/services/estoque.service');

const legado = () => new Map([
  ['123983', { descricao: 'PASTILHA', qtdEstoque: 0, unidade: 'JG', custoMedio: 35.75, precoVendaVarejo: 102.82, precoVendaAtacado: 80.55, atualizadoEm: null }],
  ['999', { descricao: 'OUTRO', qtdEstoque: 5, unidade: 'UN', custoMedio: 1, precoVendaVarejo: 10, precoVendaAtacado: 8, atualizadoEm: null }],
]);

describe('combinarUnidades', () => {
  test('soma as 3 unidades e guarda o detalhe de cada uma', () => {
    const mapa = combinarUnidades(legado(), [
      { codigo: '123983', empresa: 'MATRIZ', qtd_estoque: '0.00', preco_venda_varejo: '102.82', preco_venda_atacado: '80.55' },
      { codigo: '123983', empresa: 'DIST', qtd_estoque: '13.00', preco_venda_varejo: '61.19', preco_venda_atacado: '53.04' },
      { codigo: '123983', empresa: 'EC', qtd_estoque: '0.00', preco_venda_varejo: '61.19', preco_venda_atacado: '53.04' },
    ]);
    const e = mapa.get('123983');
    expect(e.qtdTotal).toBe(13);
    expect(e.qtdEstoque).toBe(0); // continua sendo a da Matriz
    expect(e.unidades.map((u) => u.empresa)).toEqual(['MATRIZ', 'DIST', 'EC']);
    expect(e.unidades.find((u) => u.empresa === 'DIST')).toMatchObject({ qtd: 13, precoVarejo: 61.19, precoAtacado: 53.04, nome: 'Distribuidora' });
  });

  test('produto sem linha por unidade fica como antes (total = Matriz, unidades = null)', () => {
    const mapa = combinarUnidades(legado(), []);
    expect(mapa.get('999')).toMatchObject({ qtdTotal: 5, unidades: null });
  });

  test('código que só existe numa unidade ganha entrada nova', () => {
    const mapa = combinarUnidades(legado(), [
      { codigo: 'x-1', empresa: 'DIST', qtd_estoque: '2', preco_venda_varejo: null, preco_venda_atacado: null },
    ]);
    expect(mapa.get('X1')).toMatchObject({ qtdEstoque: 0, qtdTotal: 2 });
    expect(mapa.get('X1').unidades[0]).toMatchObject({ empresa: 'DIST', precoVarejo: null });
  });

  test('ignora empresa desconhecida', () => {
    const mapa = combinarUnidades(legado(), [{ codigo: '999', empresa: 'OUTRA', qtd_estoque: '50', preco_venda_varejo: null, preco_venda_atacado: null }]);
    expect(mapa.get('999')).toMatchObject({ qtdTotal: 5, unidades: null });
  });
});

describe('normalizarEmpresa', () => {
  test('aceita só MATRIZ, DIST e EC (sem diferenciar maiúsculas)', () => {
    expect(EMPRESAS).toEqual(['MATRIZ', 'DIST', 'EC']);
    expect(normalizarEmpresa(' dist ')).toBe('DIST');
    expect(normalizarEmpresa('Matriz')).toBe('MATRIZ');
    expect(normalizarEmpresa('todas')).toBeNull();
    expect(normalizarEmpresa('')).toBeNull();
  });
});
