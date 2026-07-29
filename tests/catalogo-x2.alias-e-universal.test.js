/**
 * PEDIDO DO USUÁRIO (2026-07-27): "meu catálogo de consultas acredito que não
 * está captando todas as peças do meu dicionário, peças com Universal,
 * Diversos, GM - General Motors".
 *
 * Achado escaneando o catálogo real (config/catalogo-x2/*.json, 17.417
 * produtos): duas causas raiz, ambas em catalogo-x2.service.js.
 *
 * 1. ~1000 produtos (742 "UNIVERSAL" + 261 "DIVERSOS") têm texto de
 *    aplicação genérico, sem citar nenhum modelo específico (ex:
 *    "UNIVERSAL - Veículo Todos os modelos", "Diversos tipos de
 *    caminhões..."). buscarPorVeiculo()/buscarProdutosPainel() exigiam bater
 *    token do MODELO pesquisado com o texto de aplicação — essas peças
 *    nunca apareciam numa busca por veículo específico, mesmo servindo pra
 *    qualquer carro daquela categoria.
 *
 * 2. A mesma marca de veículo aparece grafada de 3 formas no catálogo real:
 *    "GM" (1504 produtos), "GENERAL MOTORS" (384) e "CHEVROLET" (1110) —
 *    tratadas como marcas DISTINTAS na busca por token (aplicacaoPalavras é
 *    por PALAVRA: "GENERAL MOTORS" vira dois tokens, nenhum batendo com uma
 *    busca por "GM" ou "Chevrolet").
 *
 * DECISÃO (discutida com o usuário):
 *  - Universal/Diversos entram na busca por veículo específico SÓ quando uma
 *    categoria foi informada (evita poluir toda busca genérica sem filtro).
 *  - GM/General Motors/Chevrolet tratados como sinônimos (GRUPOS_ALIAS_MARCA).
 *
 * Estes testes rodam contra o catálogo REAL (o serviço não aceita injeção de
 * dados — indexa direto de config/catalogo-x2/*.json no require), igual ao
 * padrão já usado nesta suíte pra outros módulos que dependem de dados reais
 * de produção. Os números abaixo (742/261/1504/384/1110, contagem de
 * "amortecedor" por marca etc.) foram conferidos ao vivo antes de escrever o
 * teste — se o catálogo real mudar de tamanho no futuro, os testes de
 * contagem exata podem precisar de ajuste, mas os testes de
 * comportamento/paridade (ex: "GM" e "Chevrolet" devolvem o mesmo total)
 * continuam válidos independente do tamanho do catálogo.
 */
const {
  buscarProdutosPainel,
  buscarPorVeiculo,
} = require("../src/services/catalogo-x2.service");

describe("catalogo-x2.service — alias de marca GM/General Motors/Chevrolet", () => {
  test("buscar por 'GM', 'General Motors' e 'Chevrolet' (mesma categoria) devolve o MESMO total — antes eram grafias isoladas", () => {
    const porGM = buscarProdutosPainel({ marca: "GM", categoria: "amortecedor", limite: 500 });
    const porGeneralMotors = buscarProdutosPainel({ marca: "General Motors", categoria: "amortecedor", limite: 500 });
    const porChevrolet = buscarProdutosPainel({ marca: "Chevrolet", categoria: "amortecedor", limite: 500 });

    expect(porGM.total).toBeGreaterThan(0);
    expect(porGeneralMotors.total).toBe(porGM.total);
    expect(porChevrolet.total).toBe(porGM.total);
  });

  test("marcaCompativel fica true buscando modelo + marca 'Chevrolet' num produto cuja aplicação só cita 'GM'", () => {
    // Astra Hatch é um produto real do catálogo com aplicação "GM\nAstra
    // Hatch 1998 > 2011" (sem a palavra "Chevrolet" nem "General Motors").
    const resultado = buscarProdutosPainel({ marca: "Chevrolet", modelo: "Astra", limite: 50 });
    expect(resultado.total).toBeGreaterThan(0);
    expect(resultado.produtos.some(p => p.marcaCompativel)).toBe(true);
  });
});

describe("catalogo-x2.service — peças Universal/Diversos entram na busca por veículo quando a categoria bate", () => {
  test("buscar um modelo específico + categoria traz também as peças Universal daquela categoria", () => {
    const resultado = buscarProdutosPainel({ modelo: "Onix", categoria: "buzina", limite: 500 });
    const temUniversal = resultado.produtos.some(p => /universal/i.test(p.aplicacao || ""));
    expect(temUniversal).toBe(true);
  });

  test("SEM categoria informada, peça puramente Universal (aplicação = 'UNIVERSAL') NÃO entra — evita poluir busca genérica", () => {
    const resultado = buscarProdutosPainel({ modelo: "Onix", limite: 1000 });
    const temUniversalPuro = resultado.produtos.some(
      p => (p.aplicacao || "").trim().toUpperCase() === "UNIVERSAL"
    );
    expect(temUniversalPuro).toBe(false);
  });

  test("buscarPorVeiculo (usado pelo bot) também inclui peça Universal quando a seção/linha da mensagem bate", () => {
    // "BUZINAS" (plural) é o nome exato da seção no catálogo real — sem
    // linha específica candidata, buscarPorVeiculo cai pra restringir por
    // SEÇÃO inteira (precisa da grafia da seção aparecer na mensagem).
    const resultado = buscarPorVeiculo("preciso de buzinas pro meu onix 2015", []);
    const temUniversal = resultado.some(p => /universal/i.test(p.aplicacao || ""));
    expect(temUniversal).toBe(true);
  });
});
