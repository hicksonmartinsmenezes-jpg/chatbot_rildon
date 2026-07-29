/**
 * Testes de scripts/x2-catalogo-sync.js — a parte testável sem navegador é
 * o parser do texto bruto da tela "Compras > Catálogo de Produtos".
 *
 * O fixture abaixo (`TEXTO_GERADOR_REAL`) é um recorte real capturado ao
 * vivo em 2026-07-28 direto da tela do X2 (seção GERADOR, primeiros 2
 * produtos, cada um repetido 3x — uma vez por unidade/depósito, como o
 * X2 sempre faz). Validado na hora: rodando o parser contra o texto
 * COMPLETO da seção (não só este recorte), os 18 códigos encontrados
 * bateram 100% com os 18 já salvos em src/config/catalogo-x2/gerador.json,
 * na mesma ordem — prova de que a extração reproduz exatamente os dados
 * que já confiamos.
 */
'use strict';

jest.mock('playwright', () => ({ chromium: { launchPersistentContext: jest.fn() } }), { virtual: true });

const { parsearProdutos, calcularDiferenca, CABECALHO_RESULTADO } = require('../scripts/x2-catalogo-sync');

const TEXTO_GERADOR_REAL =
  'Catálogo de Produtos \nCritérios de Pesquisa\n(...)\n' +
  CABECALHO_RESULTADO + '\n' +
  '1\t\t101476 - ANEL CALCO DO ROLAMENTO BOSCH - EDANTI - ED 0063\n' +
  'Código de barras: 7890001014761\n' +
  'GERADOR > BUCHA\t\t\n' +
  'Peso:  Kg\nAltura:  cm\nLargura:  cm\nComp.:  cm\n\n\n\n\n\n' +
  '2\t\t101476 - ANEL CALCO DO ROLAMENTO BOSCH - EDANTI - ED 0063\n' +
  'Código de barras: 7890001014761\n' +
  'GERADOR > BUCHA\t\t\n' +
  'Peso:  Kg\nAltura:  cm\nLargura:  cm\nComp.:  cm\n\n\n\n\n\n' +
  '3\t\t101476 - ANEL CALCO DO ROLAMENTO BOSCH - EDANTI - ED 0063\n' +
  'Código de barras: 7890001014761\n' +
  'GERADOR > BUCHA\t\t\n' +
  'Peso:  Kg\nAltura:  cm\nLargura:  cm\nComp.:  cm\n\n\n\n\n\n' +
  '4\t\t101475 - ANEL CALCO DO ROLAMENTO WAPSA - EDANTI - ED 0062\n' +
  'Código de barras: 7890001014754\n' +
  'GERADOR > BUCHA\t\t\n' +
  'Peso:  Kg\nAltura:  cm\nLargura:  cm\nComp.:  cm\n\n\n\n\n\n' +
  '5\t\t101475 - ANEL CALCO DO ROLAMENTO WAPSA - EDANTI - ED 0062\n' +
  'Código de barras: 7890001014754\n' +
  'GERADOR > BUCHA\t\t\n' +
  'Peso:  Kg\nAltura:  cm\nLargura:  cm\nComp.:  cm\n\n\n\n\n\n' +
  '6\t\t101475 - ANEL CALCO DO ROLAMENTO WAPSA - EDANTI - ED 0062\n' +
  'Código de barras: 7890001014754\n' +
  'GERADOR > BUCHA\t\t\n' +
  'Peso:  Kg\nAltura:  cm\nLargura:  cm\nComp.:  cm';

describe('x2-catalogo-sync.parsearProdutos', () => {
  test('deduplica as 3 repetições (uma por unidade/depósito) e mantém a ordem de 1ª aparição', () => {
    const produtos = parsearProdutos(TEXTO_GERADOR_REAL);
    expect(produtos.map((p) => p.codigo)).toEqual(['101476', '101475']);
  });

  test('extrai nome, código de barras, seção e linha corretamente', () => {
    const produtos = parsearProdutos(TEXTO_GERADOR_REAL);
    expect(produtos[0]).toEqual({
      codigo: '101476',
      nome: 'ANEL CALCO DO ROLAMENTO BOSCH - EDANTI - ED 0063',
      barras: '7890001014761',
      secao: 'GERADOR',
      linha: 'BUCHA',
    });
    expect(produtos[1]).toEqual({
      codigo: '101475',
      nome: 'ANEL CALCO DO ROLAMENTO WAPSA - EDANTI - ED 0062',
      barras: '7890001014754',
      secao: 'GERADOR',
      linha: 'BUCHA',
    });
  });

  test('texto sem o cabeçalho de resultado (nenhuma busca feita ainda) retorna lista vazia', () => {
    expect(parsearProdutos('Catálogo de Produtos\nCritérios de Pesquisa\n(sem resultado)')).toEqual([]);
  });

  test('produto sem "Código de barras" ou sem "Seção > Linha" não quebra o parser — campos ficam null', () => {
    const texto =
      CABECALHO_RESULTADO + '\n' +
      '1\t\t999999 - PRODUTO SEM BARRAS NEM SECAO\n' +
      'Peso:  Kg\n\n' +
      '2\t\t888888 - OUTRO PRODUTO NORMAL\n' +
      'Código de barras: 123456\n' +
      'FILTROS > OLEO\t\t\n';
    const produtos = parsearProdutos(texto);
    expect(produtos).toEqual([
      { codigo: '999999', nome: 'PRODUTO SEM BARRAS NEM SECAO', barras: null, secao: null, linha: null },
      { codigo: '888888', nome: 'OUTRO PRODUTO NORMAL', barras: '123456', secao: 'FILTROS', linha: 'OLEO' },
    ]);
  });

  test('nome do produto com múltiplos hífens é capturado inteiro (não corta no primeiro "-")', () => {
    const texto =
      CABECALHO_RESULTADO + '\n' +
      '1\t\t123456 - PECA COM - VARIOS - HIFENS - NO NOME\n' +
      'Código de barras: 111\n' +
      'ALTERNADOR > TESTE\t\t\n';
    const produtos = parsearProdutos(texto);
    expect(produtos[0].nome).toBe('PECA COM - VARIOS - HIFENS - NO NOME');
  });
});

describe('x2-catalogo-sync.calcularDiferenca — pedido do usuário 2026-07-28: detectar produtos desativados', () => {
  const existentes = [
    { codigo: '111', nome: 'Produto A' },
    { codigo: '222', nome: 'Produto B' },
    { codigo: '333', nome: 'Produto C' },
  ];

  test('código que já existe e ainda aparece no X2: não é novo nem removido', () => {
    const encontrados = [{ codigo: '111', nome: 'Produto A' }];
    const { novos, removidos } = calcularDiferenca(existentes, encontrados);
    expect(novos).toEqual([]);
    expect(removidos.map((r) => r.codigo).sort()).toEqual(['222', '333']);
  });

  test('código novo no X2 (não estava no JSON) entra em "novos"', () => {
    const encontrados = [{ codigo: '111' }, { codigo: '222' }, { codigo: '333' }, { codigo: '444', nome: 'Produto D' }];
    const { novos, removidos } = calcularDiferenca(existentes, encontrados);
    expect(novos).toEqual([{ codigo: '444', nome: 'Produto D' }]);
    expect(removidos).toEqual([]);
  });

  test('código que estava no JSON mas sumiu do X2 entra em "removidos" (provável desativado)', () => {
    const encontrados = [{ codigo: '111' }, { codigo: '222' }]; // 333 sumiu
    const { removidos } = calcularDiferenca(existentes, encontrados);
    expect(removidos).toEqual([{ codigo: '333', nome: 'Produto C' }]);
  });

  test('X2 retorna a seção vazia: todos os existentes viram "removidos", nenhum "novo"', () => {
    const { novos, removidos } = calcularDiferenca(existentes, []);
    expect(novos).toEqual([]);
    expect(removidos).toHaveLength(3);
  });

  test('JSON vazio (seção nova): tudo que o X2 retornar é "novo", nada é "removido"', () => {
    const encontrados = [{ codigo: '111' }, { codigo: '222' }];
    const { novos, removidos } = calcularDiferenca([], encontrados);
    expect(novos).toEqual(encontrados);
    expect(removidos).toEqual([]);
  });
});
