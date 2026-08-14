/**
 * Testes de catalogo-x2.service.js — buscarPorNomePainel (pedido do usuário,
 * 2026-08-14: "gostaria que no meu painel de catálogo também tivesse opção
 * de pesquisar por peça nome") — 3ª forma de busca do painel "Catálogo de
 * Produtos", ao lado de busca por veículo (buscarProdutosPainel) e por
 * código (buscarPorCodigo).
 *
 * Usa fixtures sintéticas (via mock de fs), mesmo padrão de
 * catalogo-x2.service.buscarProdutosPainel.test.js — os testes validam
 * COMPORTAMENTO da busca (substring, todas as palavras exigidas, ordenação
 * por nome mais curto primeiro), não um snapshot do catálogo real.
 *
 * Diferente de buscarPorNomeProduto (usado pelo BOT, tests/
 * catalogo-x2.buscarPorNomeProduto.test.js) — aquela função filtra palavra
 * genérica/veículo pra não confirmar peça errada numa MENSAGEM LIVRE do
 * cliente. Aqui o atendente está deliberadamente pesquisando por nome, texto
 * controlado — sem stopword, sem mínimo de tokens, e aceita SUBSTRING
 * (palavra parcial já acha).
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
  {
    codigo: "N1",
    nome: "ALTERNADOR 12V 90A TESTE",
    secao: "ALTERNADOR",
    linha: "ALTERNADOR COMPLETO",
    ficha: { referencia: "REF-N1", aplicacao: "GM Astra 1998 > 2009", equivalentesLista: [], referenciasCruzadas: {} },
  },
  // Nome mais longo, mesma palavra "ALTERNADOR" — deve ficar DEPOIS de N1
  // no ranking (desempate por nome mais curto primeiro).
  {
    codigo: "N2",
    nome: "ALOJAMENTO ALTERNADOR COMPLETO COM ROLAMENTO TESTE LONGO",
    secao: "ALTERNADOR",
    linha: "ALOJAMENTO",
    ficha: { referencia: "REF-N2", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} },
  },
  {
    codigo: "N3",
    nome: "CORREIA DENTADA TESTE",
    secao: "CORREIA",
    linha: "CORREIA DENTADA",
    ficha: { referencia: "REF-N3", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} },
  },
  {
    codigo: "N4",
    nome: "CORREIA POLY V TESTE",
    secao: "CORREIA",
    linha: "CORREIA POLY V",
    ficha: { referencia: "REF-N4", aplicacao: null, equivalentesLista: [], referenciasCruzadas: {} },
  },
  {
    codigo: "N5",
    nome: "SENSOR DE OXIGENIO TESTE",
    secao: "SENSORES",
    linha: "SENSOR DE OXIGENIO",
    ficha: { referencia: "REF-N5", aplicacao: null, equivalentesLista: ["EQUIVN5"], referenciasCruzadas: {} },
  },
];

fs.readdirSync.mockReturnValue(["produtos-nome-teste.json"]);
fs.readFileSync.mockReturnValue(JSON.stringify(FIXTURE));

const { buscarPorNomePainel } = require("../src/services/catalogo-x2.service");

describe("catalogo-x2.service.buscarPorNomePainel", () => {
  test("sem texto → nenhum resultado, sem varrer o catálogo", () => {
    expect(buscarPorNomePainel("")).toEqual({ total: 0, produtos: [] });
    expect(buscarPorNomePainel("   ")).toEqual({ total: 0, produtos: [] });
  });

  test("palavra INTEIRA acha o produto — 'alternador' acha N1 e N2", () => {
    const r = buscarPorNomePainel("alternador");
    expect(r.total).toBe(2);
    expect(r.produtos.map(p => p.codigo).sort()).toEqual(["N1", "N2"]);
  });

  // Diferente de buscarPorNomeProduto (usado pelo bot): aqui é busca por
  // SUBSTRING de propósito — o atendente pode digitar só o começo da palavra.
  test("palavra PARCIAL (substring) também acha — 'alternad' acha N1 e N2", () => {
    const r = buscarPorNomePainel("alternad");
    expect(r.total).toBe(2);
    expect(r.produtos.map(p => p.codigo).sort()).toEqual(["N1", "N2"]);
  });

  test("ordena nome mais curto primeiro — N1 (nome enxuto) antes de N2 (nome longo)", () => {
    const r = buscarPorNomePainel("alternador");
    expect(r.produtos[0].codigo).toBe("N1");
    expect(r.produtos[1].codigo).toBe("N2");
  });

  test("múltiplas palavras exigem TODAS presentes — 'correia dentada' só acha N3, não N4", () => {
    const r = buscarPorNomePainel("correia dentada");
    expect(r.total).toBe(1);
    expect(r.produtos[0].codigo).toBe("N3");
  });

  test("só 'correia' (sem 2ª palavra) acha as duas peças de correia (N3 e N4)", () => {
    const r = buscarPorNomePainel("correia");
    expect(r.total).toBe(2);
    expect(r.produtos.map(p => p.codigo).sort()).toEqual(["N3", "N4"]);
  });

  test("nome que não existe no catálogo → nenhum resultado", () => {
    const r = buscarPorNomePainel("peça inexistente xyz123");
    expect(r).toEqual({ total: 0, produtos: [] });
  });

  test("resultado inclui os mesmos campos do card do painel (equivalentes, referencia etc.)", () => {
    const r = buscarPorNomePainel("sensor de oxigenio");
    expect(r.total).toBe(1);
    expect(r.produtos[0]).toMatchObject({
      codigo: "N5",
      nome: "SENSOR DE OXIGENIO TESTE",
      referencia: "REF-N5",
      equivalentes: ["EQUIVN5"],
      marcaCompativel: false,
      anoCompativel: false,
    });
  });

  test("respeita o parâmetro limite", () => {
    const r = buscarPorNomePainel("correia", { limite: 1 });
    expect(r.total).toBe(2); // total real continua 2...
    expect(r.produtos.length).toBe(1); // ...mas só devolve 1 produto
  });
});
