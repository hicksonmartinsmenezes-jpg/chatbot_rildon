/**
 * Testes de catalogo-x2.service.js — buscarProdutosPainel (Task #240-243,
 * pedido do usuário em 2026-07-21): novo painel "Catálogo de Produtos" onde
 * o atendente digita marca/modelo/ano (+ categoria opcional) do veículo do
 * cliente e recebe as peças compatíveis do catálogo real (~17.400 produtos).
 *
 * Usa fixtures sintéticas (via mock de fs) em vez do catálogo real — o
 * catálogo real é conteúdo de dados que pode mudar, os testes devem validar
 * o COMPORTAMENTO da busca, não um snapshot de produtos específicos.
 *
 * Decisões do usuário refletidas aqui:
 *   - Ano é auxiliar (marcaCompativel/anoCompativel), nunca exclui produto.
 *   - Categoria é filtro opcional.
 */
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

const fs = require("fs");

const FIXTURE = [
  // Match forte: marca+modelo+ano batem, categoria "alternador" bate na seção.
  // Nome sem " - " → fabricante não identificável (null), pra testar que o
  // filtro de fabricante EXCLUI esse produto quando outro fabricante é pedido.
  {
    codigo: "P1",
    nome: "ALOJAMENTO ALTER TESTE",
    secao: "ALTERNADOR",
    linha: "ALOJAMENTO",
    ficha: {
      referencia: "REF1",
      aplicacao: "GM\nAstra, 1.8 1998 > 2001\nAstra, 2.0 1998 > 2009",
      equivalentesLista: ["BOSCH0123"],
      referenciasCruzadas: {},
    },
  },
  // Mesma linha de veículo (Astra), mas texto de aplicação GIGANTE (produto
  // "universal") — deve ficar ATRÁS do P1 no ranking por especificidade.
  {
    codigo: "P2",
    nome: "PALHETA UNIVERSAL TESTE",
    secao: "ACESSORIOS",
    linha: "PALHETA",
    ficha: {
      referencia: null,
      aplicacao: "Astra Corolla Gol Palio Uno Fiesta Ka Onix Civic Fit HB20 Argo Cronos Mobi Kwid Sandero Logan Duster Renegade Compass Tracker Spin Cobalt Prisma Voyage Fox",
      equivalentesLista: [],
      referenciasCruzadas: {},
    },
  },
  // Veículo diferente (Corolla), sem ano — não deve aparecer numa busca por Astra.
  {
    codigo: "P3",
    nome: "FAROL TOYOTA TESTE",
    secao: "FAROIS",
    linha: "FAROL DIANTEIRO",
    ficha: {
      referencia: "REF3",
      aplicacao: "Toyota Corolla 2015 > 2019",
      equivalentesLista: [],
      referenciasCruzadas: {},
    },
  },
  // Peça genérica sem texto de aplicação/veículo (ex real: abraçadeira de
  // nylon) — achado ao vivo em 2026-07-22: ~1.900 produtos assim ficavam
  // invisíveis em QUALQUER busca por marca/modelo. Só deve aparecer no modo
  // navegação (categoria sozinha, sem marca/modelo).
  {
    codigo: "P4",
    nome: "ABRACADEIRA NYLON TESTE",
    secao: "ACESSORIOS",
    linha: "ABRACADEIRA DE NYLON",
    ficha: {
      referencia: "REF4",
      aplicacao: null,
      equivalentesLista: [],
      referenciasCruzadas: {},
    },
  },
  // Fabricante identificável (nome com exatamente 3 blocos " - ") — veículo
  // DIFERENTE do usado nos testes de "Astra" acima (Vectra, não Astra) de
  // propósito, pra não alterar a contagem dos testes já existentes que
  // buscam por modelo:"Astra". Usado só nos testes novos de fabricante +
  // veículo (Task #250-253, 2026-07-23).
  {
    codigo: "P5",
    nome: "SUPORTE MOTOR VECTRA GM - FABRICANTEX - SUP001",
    secao: "ALTERNADOR",
    linha: "ALOJAMENTO",
    ficha: {
      referencia: "SUP001",
      aplicacao: "GM Vectra 1999 > 2010",
      equivalentesLista: [],
      referenciasCruzadas: {},
    },
  },
  // Fabricante identificável, SEM aplicação/veículo — testa que o filtro de
  // fabricante funciona no modo navegação igual à categoria (achado ao vivo:
  // ~1.900 produtos genéricos não tinham como aparecer em nenhuma busca).
  // Seção/linha PROPOSITALMENTE únicas (não "ACESSORIOS") pra não alterar a
  // contagem do teste já existente de modo-navegação-por-seção (P2+P4).
  {
    codigo: "P6",
    nome: "ABRACADEIRA METALICA - OUTRAMARCA - AB002",
    secao: "FERRAGENS TESTE",
    linha: "ABRACADEIRA METALICA TESTE",
    ficha: {
      referencia: null,
      aplicacao: null,
      equivalentesLista: [],
      referenciasCruzadas: {},
    },
  },
  // Referência própria com fabricante GRUDADO ("COD777 - MARCATESTE") — bug
  // real achado ao vivo em 2026-07-23: o índice normalizava a string inteira
  // e buscar só "COD777" não achava nada. Seção isolada pra não interferir
  // em nenhum outro teste de categoria/veículo.
  {
    codigo: "P7",
    nome: "PECA TESTE REFERENCIA COM FABRICANTE",
    secao: "SISTEMA X TESTE",
    linha: "LINHA X TESTE",
    ficha: {
      referencia: "COD777 - MARCATESTE",
      aplicacao: null,
      equivalentesLista: [],
      referenciasCruzadas: {},
    },
  },
  // P8-P11: 4 clones de FABRICANTEX sem aplicação/veículo — só pra cruzar o
  // FABRICANTE_MIN_OCORRENCIAS (>=5, ver catalogo-x2.service.js) e testar
  // que listarFabricantes() só mostra fabricante com volume mínimo de
  // produtos (corta ruído de parsing). OUTRAMARCA (P6, só 1 ocorrência) fica
  // DE PROPÓSITO abaixo do limiar — prova que o filtro em si continua
  // funcionando mesmo pra fabricante raro que não aparece no dropdown.
  { codigo: "P8", nome: "PECA GENERICA 1 - FABRICANTEX - GEN001", secao: "SISTEMA X TESTE", linha: "LINHA X TESTE",
    ficha: { referencia: "GEN001", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} } },
  { codigo: "P9", nome: "PECA GENERICA 2 - FABRICANTEX - GEN002", secao: "SISTEMA X TESTE", linha: "LINHA X TESTE",
    ficha: { referencia: "GEN002", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} } },
  { codigo: "P10", nome: "PECA GENERICA 3 - FABRICANTEX - GEN003", secao: "SISTEMA X TESTE", linha: "LINHA X TESTE",
    ficha: { referencia: "GEN003", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} } },
  { codigo: "P11", nome: "PECA GENERICA 4 - FABRICANTEX - GEN004", secao: "SISTEMA X TESTE", linha: "LINHA X TESTE",
    ficha: { referencia: "GEN004", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} } },
];

fs.readdirSync.mockReturnValue(["produtos-teste.json"]);
fs.readFileSync.mockReturnValue(JSON.stringify(FIXTURE));

const { buscarProdutosPainel, buscarPorCodigo, listarFabricantes } = require("../src/services/catalogo-x2.service");

describe("catalogo-x2.service.buscarProdutosPainel", () => {
  test("sem marca e sem modelo → não busca (evita devolver o catálogo inteiro)", () => {
    const r = buscarProdutosPainel({});
    expect(r).toEqual({ total: 0, produtos: [] });
  });

  test("marca+modelo+ano+categoria batendo → acha o produto certo com badges true", () => {
    const r = buscarProdutosPainel({ marca: "GM", modelo: "Astra", ano: 2005, categoria: "alternador" });

    expect(r.total).toBe(1);
    expect(r.produtos[0]).toMatchObject({
      codigo: "P1",
      marcaCompativel: true,
      anoCompativel: true,
    });
  });

  test("categoria filtra por seção/linha — 'alternador' não devolve produto de outra seção", () => {
    const r = buscarProdutosPainel({ modelo: "Astra", categoria: "farol" });
    expect(r.total).toBe(0);
  });

  test("sem categoria, busca por modelo cruza todas as seções e prioriza o mais específico", () => {
    const r = buscarProdutosPainel({ modelo: "Astra" });

    expect(r.total).toBe(2); // P1 (Alternador) e P2 (Palheta universal) citam Astra
    // P1 tem aplicação bem mais curta (mais específica) que a P2 (universal,
    // dezenas de modelos) — deve vir primeiro no ranking (desempate por
    // especificidade, ver comentário em buscarProdutosPainel).
    expect(r.produtos[0].codigo).toBe("P1");
    expect(r.produtos[1].codigo).toBe("P2");
  });

  test("modelo de outro veículo não aparece na busca (P3 é Corolla, buscando Astra)", () => {
    const r = buscarProdutosPainel({ modelo: "Astra" });
    expect(r.produtos.find(p => p.codigo === "P3")).toBeUndefined();
  });

  test("ano fora da faixa cadastrada NÃO exclui o produto (ano é auxiliar, não filtro)", () => {
    const r = buscarProdutosPainel({ modelo: "Astra", ano: 1980 });
    expect(r.total).toBe(2);
    const p1 = r.produtos.find(p => p.codigo === "P1");
    expect(p1.anoCompativel).toBe(false); // não bate, mas continua na lista
  });

  test("marca sozinha (sem modelo) vira o token obrigatório", () => {
    const r = buscarProdutosPainel({ marca: "GM" });
    expect(r.produtos.some(p => p.codigo === "P1")).toBe(true);
    // marcaCompativel é sempre true aqui, já que GM foi o próprio critério obrigatório
    expect(r.produtos.find(p => p.codigo === "P1").marcaCompativel).toBe(true);
  });

  test("marca ausente no texto de aplicação não exclui o produto (achado ao vivo: marca às vezes é omitida)", () => {
    // P3 (Corolla) não menciona "Toyota" explicitamente em minúsculas/maiúsculas? Na
    // verdade menciona — usamos P1 (Astra) que não cita "Chevrolet" pra provar o ponto:
    // buscando marca=Chevrolet + modelo=Astra, o produto ainda aparece (modelo já é
    // suficiente), só não ganha o badge de marca.
    const r = buscarProdutosPainel({ marca: "Chevrolet", modelo: "Astra" });
    const p1 = r.produtos.find(p => p.codigo === "P1");
    expect(p1).toBeDefined();
    expect(p1.marcaCompativel).toBe(false);
  });

  test("categoria inexistente devolve lista vazia (não quebra)", () => {
    const r = buscarProdutosPainel({ modelo: "Astra", categoria: "zzz-categoria-que-nao-existe" });
    expect(r).toEqual({ total: 0, produtos: [] });
  });

  // Modo navegação (pedido do usuário, 2026-07-22): categoria sozinha, sem
  // marca/modelo, lista TODO o catálogo daquela categoria — inclusive
  // produtos sem aplicação/veículo cadastrado (P4), que o modo de busca por
  // veículo nunca alcançaria.
  describe("modo navegação (só categoria, sem marca/modelo)", () => {
    test("acha produto SEM aplicação cadastrada (P4) que a busca por veículo nunca alcançaria", () => {
      const r = buscarProdutosPainel({ categoria: "ABRACADEIRA DE NYLON" });
      expect(r.total).toBe(1);
      expect(r.produtos[0]).toMatchObject({ codigo: "P4", marcaCompativel: false, anoCompativel: false });
    });

    test("categoria por seção também funciona no modo navegação (P2 e P4 são da mesma seção)", () => {
      const r = buscarProdutosPainel({ categoria: "ACESSORIOS" });
      expect(r.total).toBe(2); // P2 (Palheta) e P4 (Abraçadeira) — mesma seção "ACESSORIOS"
      expect(r.produtos.some(p => p.codigo === "P4")).toBe(true);
    });

    test("sem marca, modelo E categoria → não busca (evita devolver o catálogo inteiro sem filtro nenhum)", () => {
      const r = buscarProdutosPainel({});
      expect(r).toEqual({ total: 0, produtos: [] });
    });

    test("categoria inexistente no modo navegação devolve lista vazia", () => {
      const r = buscarProdutosPainel({ categoria: "zzz-nao-existe" });
      expect(r).toEqual({ total: 0, produtos: [] });
    });
  });

  // Filtro por fabricante (Task #250-253, pedido do usuário em 2026-07-23):
  // não é campo estruturado no catálogo real, é extraído do nome do produto
  // (formato "descrição - FABRICANTE - referência"). P1/P3/P4/P6 não têm
  // fabricante identificável (nome sem 3 blocos " - "); P5 e P6 têm.
  describe("filtro por fabricante", () => {
    test("listarFabricantes() só mostra fabricante com volume mínimo de produtos (corta ruído)", () => {
      const fabricantes = listarFabricantes();
      // FABRICANTEX tem 5 produtos na fixture (P5,P8-P11) → passa do limiar.
      expect(fabricantes).toContain("FABRICANTEX");
      // OUTRAMARCA (P6) tem só 1 produto → fica de fora do dropdown, mas
      // continua funcionando como filtro direto (ver teste abaixo).
      expect(fabricantes).not.toContain("OUTRAMARCA");
    });

    test("fabricante sozinho (sem marca/modelo) entra no modo navegação — acha produto sem aplicação (P6)", () => {
      const r = buscarProdutosPainel({ fabricante: "OUTRAMARCA" });
      expect(r.total).toBe(1);
      expect(r.produtos[0]).toMatchObject({ codigo: "P6", fabricante: "OUTRAMARCA" });
    });

    test("fabricante + veículo juntos: só o produto com esse fabricante E esse veículo aparece", () => {
      const r = buscarProdutosPainel({ modelo: "Vectra", fabricante: "FABRICANTEX" });
      expect(r.total).toBe(1);
      expect(r.produtos[0].codigo).toBe("P5");
    });

    test("veículo bate mas fabricante não → produto some (fabricante É filtro de exclusão, diferente de marca/ano)", () => {
      const r = buscarProdutosPainel({ modelo: "Vectra", fabricante: "OUTRAMARCA" });
      expect(r.total).toBe(0);
    });

    test("fabricante que não existe no catálogo devolve lista vazia", () => {
      const r = buscarProdutosPainel({ fabricante: "MARCA-QUE-NAO-EXISTE" });
      expect(r).toEqual({ total: 0, produtos: [] });
    });
  });
});

// ─── Busca direta por código (Task #250-253) ───────────────────────────────
describe("catalogo-x2.service.buscarPorCodigo", () => {
  test("acha pela referência própria do produto (P1: REF1)", () => {
    const r = buscarPorCodigo("REF1");
    expect(r.some(p => p.codigo === "P1")).toBe(true);
  });

  test("acha por código equivalente/OEM cadastrado (P1 equivale a BOSCH0123)", () => {
    const r = buscarPorCodigo("BOSCH0123");
    expect(r.some(p => p.codigo === "P1")).toBe(true);
  });

  test("acha pelo código interno do produto (não só pela referência do fabricante)", () => {
    const r = buscarPorCodigo("P4");
    expect(r.some(p => p.codigo === "P4")).toBe(true);
  });

  test("aceita minúsculas, espaços e pontuação (normaliza igual ao índice)", () => {
    const r = buscarPorCodigo(" ref1 ");
    expect(r.some(p => p.codigo === "P1")).toBe(true);
  });

  test("referência com fabricante GRUDADO (\"COD777 - MARCATESTE\") — indexa só a parte do código", () => {
    const r = buscarPorCodigo("COD777");
    expect(r.some(p => p.codigo === "P7")).toBe(true);
  });

  test("código inexistente devolve lista vazia", () => {
    expect(buscarPorCodigo("ZZZINEXISTENTE999")).toEqual([]);
  });

  test("string vazia/undefined não quebra", () => {
    expect(buscarPorCodigo("")).toEqual([]);
    expect(buscarPorCodigo(undefined)).toEqual([]);
  });
});
