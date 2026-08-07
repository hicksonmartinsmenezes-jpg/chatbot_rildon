/**
 * Testes de catalogo-x2.service.js — anexação do campo `estoque` (pedido
 * do usuário 2026-08-07, "Estoque ao vivo no Catálogo/orçamento").
 *
 * estoque.service.js é mockado (jest.mock) pra não depender de Postgres
 * real — só testa que catalogo-x2.service CONSULTA obterEstoque(codigo) e
 * anexa o resultado certo, sem quebrar quando não tem dado (null).
 */
jest.mock('../src/services/estoque.service', () => ({
  obterEstoque: jest.fn(),
}));

const estoqueService = require('../src/services/estoque.service');
const catalogoX2 = require('../src/services/catalogo-x2.service');

describe('catalogo-x2.service: campo estoque anexado', () => {
  afterEach(() => {
    estoqueService.obterEstoque.mockReset();
  });

  test('buscarPorCodigo anexa estoque quando obterEstoque retorna dado', () => {
    estoqueService.obterEstoque.mockReturnValue({
      qtdEstoque: 10, unidade: 'PC', precoVendaVarejo: 64.53, precoVendaAtacado: 46.22,
    });

    // código real do catálogo de teste (ver fixtures em src/config/catalogo-x2)
    const [produto] = catalogoX2.buscarPorCodigo('116564');
    expect(produto).toBeDefined();
    expect(produto.estoque).toEqual({
      qtd: 10, unidade: 'PC', precoVarejo: 64.53, precoAtacado: 46.22,
    });
    expect(estoqueService.obterEstoque).toHaveBeenCalledWith('116564');
  });

  test('buscarPorCodigo retorna estoque null quando não tem dado (sem quebrar)', () => {
    estoqueService.obterEstoque.mockReturnValue(null);
    const [produto] = catalogoX2.buscarPorCodigo('116564');
    expect(produto).toBeDefined();
    expect(produto.estoque).toBeNull();
  });

  test('buscarProdutosPainel (modo navegação) anexa estoque em cada produto', () => {
    estoqueService.obterEstoque.mockReturnValue({
      qtdEstoque: 0, unidade: 'UN', precoVendaVarejo: null, precoVendaAtacado: null,
    });
    const { produtos } = catalogoX2.buscarProdutosPainel({ categoria: 'BUZINAS', limite: 3 });
    expect(produtos.length).toBeGreaterThan(0);
    for (const p of produtos) {
      expect(p.estoque).toEqual({ qtd: 0, unidade: 'UN', precoVarejo: null, precoAtacado: null });
    }
  });
});
