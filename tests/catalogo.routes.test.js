/**
 * Testes de catalogo.routes.js / catalogo.controller.js — foco nas duas
 * rotas novas do painel "Catálogo de Produtos" (Task #240-243, pedido do
 * usuário em 2026-07-21): GET /catalogo/buscar e GET /catalogo/secoes.
 *
 * Isola da busca real (catalogo-x2.service.js) e do catálogo real
 * (catalogo.service.js) via mock — quem testa a lógica de busca em si é
 * catalogo-x2.service.buscarProdutosPainel.test.js.
 */
jest.mock("../src/services/catalogo-x2.service", () => ({
  buscarProdutosPainel: jest.fn(),
  buscarPorCodigoOriginal: jest.fn(),
  buscarPorVeiculo: jest.fn(),
  buscarPorCodigo: jest.fn(),
  buscarPorNomePainel: jest.fn(),
  listarFabricantes: jest.fn(),
}));
jest.mock("../src/services/catalogo.service", () => ({
  listarSecoes: jest.fn(),
  buscarNoCatalogo: jest.fn(),
  listarLinhasPorSecao: jest.fn(),
}));
jest.mock("../src/services/catalogo-fotos.service", () => ({
  listarFotos: jest.fn(),
  obterFoto: jest.fn(),
}));
jest.mock("../src/services/estoque.service", () => ({
  carregarEstoque: jest.fn(),
  statusCache: jest.fn(),
}));

const express = require("express");
const request = require("supertest");

const { buscarProdutosPainel, buscarPorCodigo, buscarPorNomePainel, listarFabricantes } = require("../src/services/catalogo-x2.service");
const { listarSecoes, listarLinhasPorSecao } = require("../src/services/catalogo.service");
const { carregarEstoque, statusCache } = require("../src/services/estoque.service");
const catalogoRoutes = require("../src/routes/catalogo.routes");

function buildApp() {
  const app = express();
  app.use((req, res, next) => { req.user = { id: "u1", perfil: "atendente" }; next(); });
  app.use("/api", catalogoRoutes);
  return app;
}

describe("GET /api/catalogo/buscar", () => {
  beforeEach(() => jest.clearAllMocks());

  test("sem marca, sem modelo e sem categoria → 400", async () => {
    const res = await request(buildApp()).get("/api/catalogo/buscar");
    expect(res.status).toBe(400);
    expect(buscarProdutosPainel).not.toHaveBeenCalled();
  });

  // Modo navegação (pedido do usuário, 2026-07-22): categoria sozinha já
  // basta pra listar o catálogo inteiro daquela Seção/Linha.
  test("só categoria (sem marca/modelo) → 200, modo navegação", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 41, produtos: [{ codigo: "P1" }] });
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ categoria: "ABRAÇADEIRA DE NYLON" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "", modelo: "", ano: null, categoria: "ABRAÇADEIRA DE NYLON", fabricante: "",
    });
  });

  // Fabricante sozinho (Task #250-253, pedido do usuário em 2026-07-23):
  // mesmo modo navegação, mas filtrando só por marca da peça, sem categoria.
  test("só fabricante (sem marca/modelo/categoria) → 200, modo navegação", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 12, produtos: [{ codigo: "P6" }] });
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ fabricante: "MOBENSANI" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "", modelo: "", ano: null, categoria: "", fabricante: "MOBENSANI",
    });
  });

  test("ano fora do intervalo aceitável → 400", async () => {
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ modelo: "Gol", ano: "1800" });
    expect(res.status).toBe(400);
    expect(buscarProdutosPainel).not.toHaveBeenCalled();
  });

  test("ano não numérico → 400", async () => {
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ modelo: "Gol", ano: "abc" });
    expect(res.status).toBe(400);
  });

  test("marca+modelo válidos → 200 e repassa pro service com os parâmetros certos", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 1, produtos: [{ codigo: "P1" }] });

    const res = await request(buildApp())
      .get("/api/catalogo/buscar")
      .query({ marca: "GM", modelo: "Astra", ano: "2005", categoria: "alternador" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 1, produtos: [{ codigo: "P1" }] });
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "GM", modelo: "Astra", ano: 2005, categoria: "alternador", fabricante: "",
    });
  });

  test("só modelo (sem marca) já é suficiente → 200", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 0, produtos: [] });
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ modelo: "Corolla" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "", modelo: "Corolla", ano: null, categoria: "", fabricante: "",
    });
  });

  test("marca+modelo+fabricante → repassa fabricante junto pro service", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 1, produtos: [{ codigo: "P5" }] });
    const res = await request(buildApp())
      .get("/api/catalogo/buscar")
      .query({ marca: "GM", modelo: "Vectra", fabricante: "FABRICANTEX" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "GM", modelo: "Vectra", ano: null, categoria: "", fabricante: "FABRICANTEX",
    });
  });

  test("erro interno do service → 500 genérico", async () => {
    buscarProdutosPainel.mockImplementation(() => { throw new Error("boom"); });
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ modelo: "Gol" });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/catalogo/secoes", () => {
  beforeEach(() => jest.clearAllMocks());

  test("devolve a lista de seções do catálogo", async () => {
    listarSecoes.mockReturnValue(["ALTERNADOR", "FAROIS"]);
    const res = await request(buildApp()).get("/api/catalogo/secoes");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ secoes: ["ALTERNADOR", "FAROIS"] });
  });
});

describe("GET /api/catalogo/linhas", () => {
  beforeEach(() => jest.clearAllMocks());

  test("sem seção → devolve lista vazia sem chamar o service", async () => {
    const res = await request(buildApp()).get("/api/catalogo/linhas");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linhas: [] });
    expect(listarLinhasPorSecao).not.toHaveBeenCalled();
  });

  test("com seção → repassa pro service e devolve as linhas", async () => {
    listarLinhasPorSecao.mockReturnValue(["ALOJAMENTO", "ROTOR"]);
    const res = await request(buildApp()).get("/api/catalogo/linhas").query({ secao: "ALTERNADOR" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ linhas: ["ALOJAMENTO", "ROTOR"] });
    expect(listarLinhasPorSecao).toHaveBeenCalledWith("ALTERNADOR");
  });
});

// Task #250-253, pedido do usuário em 2026-07-23: filtro por fabricante da
// peça + busca direta por código de fabricante/referência.
describe("GET /api/catalogo/fabricantes", () => {
  beforeEach(() => jest.clearAllMocks());

  test("devolve a lista de fabricantes já filtrada pelo service", async () => {
    listarFabricantes.mockReturnValue(["MOBENSANI", "VALEO"]);
    const res = await request(buildApp()).get("/api/catalogo/fabricantes");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fabricantes: ["MOBENSANI", "VALEO"] });
  });

  test("erro interno do service → 500 genérico", async () => {
    listarFabricantes.mockImplementation(() => { throw new Error("boom"); });
    const res = await request(buildApp()).get("/api/catalogo/fabricantes");
    expect(res.status).toBe(500);
  });
});

describe("GET /api/catalogo/buscar-codigo", () => {
  beforeEach(() => jest.clearAllMocks());

  test("sem código → 400, não chama o service", async () => {
    const res = await request(buildApp()).get("/api/catalogo/buscar-codigo");
    expect(res.status).toBe(400);
    expect(buscarPorCodigo).not.toHaveBeenCalled();
  });

  test("código válido → 200 e repassa pro service", async () => {
    buscarPorCodigo.mockReturnValue([{ codigo: "P1", nome: "ALOJAMENTO ALTER TESTE" }]);
    const res = await request(buildApp()).get("/api/catalogo/buscar-codigo").query({ codigo: "REF1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 1, produtos: [{ codigo: "P1", nome: "ALOJAMENTO ALTER TESTE" }] });
    expect(buscarPorCodigo).toHaveBeenCalledWith("REF1");
  });

  test("código sem resultado → 200 com lista vazia (não é erro)", async () => {
    buscarPorCodigo.mockReturnValue([]);
    const res = await request(buildApp()).get("/api/catalogo/buscar-codigo").query({ codigo: "ZZZINEXISTENTE" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, produtos: [] });
  });

  test("erro interno do service → 500 genérico", async () => {
    buscarPorCodigo.mockImplementation(() => { throw new Error("boom"); });
    const res = await request(buildApp()).get("/api/catalogo/buscar-codigo").query({ codigo: "REF1" });
    expect(res.status).toBe(500);
  });
});

// Pedido do usuário (2026-08-14): "gostaria que no meu painel de catálogo
// também tivesse opção de pesquisar por peça nome" — 3ª forma de busca do
// painel, ao lado de /catalogo/buscar (veículo) e /catalogo/buscar-codigo.
describe("GET /api/catalogo/buscar-nome", () => {
  beforeEach(() => jest.clearAllMocks());

  test("sem nome → 400, não chama o service", async () => {
    const res = await request(buildApp()).get("/api/catalogo/buscar-nome");
    expect(res.status).toBe(400);
    expect(buscarPorNomePainel).not.toHaveBeenCalled();
  });

  test("nome informado → 200 e repassa pro service", async () => {
    buscarPorNomePainel.mockReturnValue({ total: 1, produtos: [{ codigo: "P1", nome: "ALTERNADOR TESTE" }] });
    const res = await request(buildApp()).get("/api/catalogo/buscar-nome").query({ nome: "alternador" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 1, produtos: [{ codigo: "P1", nome: "ALTERNADOR TESTE" }] });
    expect(buscarPorNomePainel).toHaveBeenCalledWith("alternador");
  });

  test("nome sem resultado → 200 com lista vazia (não é erro)", async () => {
    buscarPorNomePainel.mockReturnValue({ total: 0, produtos: [] });
    const res = await request(buildApp()).get("/api/catalogo/buscar-nome").query({ nome: "peça inexistente" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, produtos: [] });
  });

  test("erro interno do service → 500 genérico", async () => {
    buscarPorNomePainel.mockImplementation(() => { throw new Error("boom"); });
    const res = await request(buildApp()).get("/api/catalogo/buscar-nome").query({ nome: "alternador" });
    expect(res.status).toBe(500);
  });
});

// Pedido do usuário (2026-08-10): força o reload do cache de estoque em
// memória fora do ciclo normal (boot + setInterval de 30min) — chamado pelo
// pipeline scripts/x2-estoque-export.js logo após o import no Postgres, pra
// o badge de estoque no Catálogo não ficar desatualizado por até meia hora.
describe("POST /api/catalogo/estoque/recarregar", () => {
  beforeEach(() => jest.clearAllMocks());

  test("recarrega o cache e devolve o status atualizado", async () => {
    statusCache.mockReturnValue({ produtos: 8635, carregadoEm: "2026-08-10T12:00:00.000Z" });
    const res = await request(buildApp()).post("/api/catalogo/estoque/recarregar");
    expect(res.status).toBe(200);
    expect(carregarEstoque).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual({ ok: true, produtos: 8635, carregadoEm: "2026-08-10T12:00:00.000Z" });
  });

  test("erro ao recarregar → 500 genérico", async () => {
    carregarEstoque.mockImplementation(() => { throw new Error("banco fora do ar"); });
    const res = await request(buildApp()).post("/api/catalogo/estoque/recarregar");
    expect(res.status).toBe(500);
  });
});
