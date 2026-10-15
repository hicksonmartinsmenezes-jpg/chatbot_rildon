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
  // 2026-10-09: o mock tinha ficado para trás do controller/serviço, e o
  // resultado era pior que um teste vermelho — a suíte INTEIRA deixava de
  // carregar ("listarMarcasVeiculoConhecidas is not a function", chamada no
  // carregamento de catalogo-pdf.service), então 32 testes apareciam como "1
  // suite failed to run" e ninguém via que 12 deles estavam quebrados.
  // Em particular decodificarFabricanteCompleto é chamada logo no começo de
  // buscarProdutosHandler, ANTES da validação de parâmetros: sem ela, toda
  // requisição de busca virava 500 em vez do 400/200 esperado.
  listarMarcasVeiculoConhecidas: jest.fn(() => []),
  listarFabricantesCatalogoCompleto: jest.fn(() => []),
  decodificarFabricanteCompleto: jest.fn((v) => ({ fabricante: String(v || ""), tipoCompleto: null })),
  recarregarIndices: jest.fn(),
  listarLinhasParaEdicaoCategoria: jest.fn(() => []),
  definirLinhaProduto: jest.fn(),
  PSEUDO_FABRICANTE_DIVERSOS: "__DIVERSOS__",
}));
jest.mock("../src/services/catalogo.service", () => ({
  listarSecoes: jest.fn(),
  buscarNoCatalogo: jest.fn(),
  listarLinhasPorSecao: jest.fn(),
}));
jest.mock("../src/services/catalogo-fotos.service", () => ({
  listarFotos: jest.fn(),
  obterFoto: jest.fn(),
  // 2026-09-08: usado por buscarProdutosHandler pra anexar produto.duasFotos
  // em cada item da resposta — default false (produto com 1 foto só, o caso
  // comum) pra não quebrar os testes que não têm opinião sobre isso.
  temMultiplasFotos: jest.fn(() => false),
  // Upload response includes the cache-busting photo version.
  obterVersaoFotos: jest.fn(() => 1),
  // 2026-09-08 (nova função "adicionar foto"): usado por adicionarFotoHandler.
  adicionarFotoManual: jest.fn(),
  // 2026-10-09: filtro "só produto com foto" da exportação passou a usar esta
  // função (antes usava listarFotos, que lia bytes do zip — ver comentário no
  // controller). Default true pra não zerar o resultado dos testes de export.
  temAlgumaFoto: jest.fn(() => true),
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
const { temMultiplasFotos, adicionarFotoManual } = require("../src/services/catalogo-fotos.service");
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
      marca: "", modelo: "", ano: null, anoInicio: null, anoFim: null, motor: "",
      categoria: "ABRAÇADEIRA DE NYLON", fabricante: "", tipoCompleto: null,
      limite: 400, offset: 0,
    });
  });

  // Fabricante sozinho (Task #250-253, pedido do usuário em 2026-07-23):
  // mesmo modo navegação, mas filtrando só por marca da peça, sem categoria.
  test("só fabricante (sem marca/modelo/categoria) → 200, modo navegação", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 12, produtos: [{ codigo: "P6" }] });
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ fabricante: "MOBENSANI" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "", modelo: "", ano: null, anoInicio: null, anoFim: null, motor: "",
      categoria: "", fabricante: "MOBENSANI", tipoCompleto: null,
      limite: 400, offset: 0,
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
    expect(res.body).toEqual({ total: 1, produtos: [{ codigo: "P1", duasFotos: false }], pagina: 1, limite: 400 });
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "GM", modelo: "Astra", ano: 2005, anoInicio: null, anoFim: null, motor: "",
      categoria: "alternador", fabricante: "", tipoCompleto: null,
      limite: 400, offset: 0,
    });
  });

  test("só modelo (sem marca) já é suficiente → 200", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 0, produtos: [] });
    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ modelo: "Corolla" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "", modelo: "Corolla", ano: null, anoInicio: null, anoFim: null, motor: "",
      categoria: "", fabricante: "", tipoCompleto: null,
      limite: 400, offset: 0,
    });
  });

  test("marca+modelo+fabricante → repassa fabricante junto pro service", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 1, produtos: [{ codigo: "P5" }] });
    const res = await request(buildApp())
      .get("/api/catalogo/buscar")
      .query({ marca: "GM", modelo: "Vectra", fabricante: "FABRICANTEX" });
    expect(res.status).toBe(200);
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "GM", modelo: "Vectra", ano: null, anoInicio: null, anoFim: null, motor: "",
      categoria: "", fabricante: "FABRICANTEX", tipoCompleto: null,
      limite: 400, offset: 0,
    });
  });

  // Paginação (pedido do usuário, 2026-09-02 — trazida de volta em 2026-09-08
  // depois de ficar esquecida numa branch sem merge): "pagina" na query
  // vira offset repassado pro service; resposta inclui pagina/limite pro
  // frontend montar o pager.
  test("?pagina=2 → calcula offset e devolve pagina/limite na resposta", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 566, produtos: [{ codigo: "P900" }] });
    const res = await request(buildApp())
      .get("/api/catalogo/buscar")
      .query({ fabricante: "GAUSS", pagina: "2" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 566, produtos: [{ codigo: "P900", duasFotos: false }], pagina: 2, limite: 400 });
    expect(buscarProdutosPainel).toHaveBeenCalledWith({
      marca: "", modelo: "", ano: null, anoInicio: null, anoFim: null, motor: "",
      categoria: "", fabricante: "GAUSS", tipoCompleto: null,
      limite: 400, offset: 400,
    });
  });

  // 2026-09-08 (pedido do usuário: "duas fotos como no PDF" também nos
  // cards de Critérios de Pesquisa): cada produto da resposta ganha
  // duasFotos, calculado por temMultiplasFotos (catalogo-fotos.service) —
  // barato o bastante pra rodar pra cada item da página sem custo real.
  test("anexa duasFotos por produto usando temMultiplasFotos (catalogo-fotos.service)", async () => {
    buscarProdutosPainel.mockReturnValue({
      total: 2,
      produtos: [{ codigo: "P1" }, { codigo: "P2" }],
    });
    temMultiplasFotos.mockImplementation(codigo => codigo === "P2");

    const res = await request(buildApp()).get("/api/catalogo/buscar").query({ fabricante: "3RHO" });

    expect(res.status).toBe(200);
    expect(res.body.produtos).toEqual([
      { codigo: "P1", duasFotos: false },
      { codigo: "P2", duasFotos: true },
    ]);
    expect(temMultiplasFotos).toHaveBeenCalledWith("P1");
    expect(temMultiplasFotos).toHaveBeenCalledWith("P2");
  });

  test("?pagina inválida (0, negativa ou não numérica) → cai pra página 1", async () => {
    buscarProdutosPainel.mockReturnValue({ total: 12, produtos: [] });
    const res = await request(buildApp())
      .get("/api/catalogo/buscar")
      .query({ fabricante: "MOBENSANI", pagina: "abc" });
    expect(res.status).toBe(200);
    expect(res.body.pagina).toBe(1);
    expect(buscarProdutosPainel).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
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
    expect(res.body).toEqual({ total: 1, produtos: [{ codigo: "P1", nome: "ALOJAMENTO ALTER TESTE", duasFotos: false }] });
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
    expect(res.body).toEqual({ total: 1, produtos: [{ codigo: "P1", nome: "ALTERNADOR TESTE", duasFotos: false }] });
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

// Nova função (pedido do usuário, 2026-09-08): "criar possibilidade de
// adicionar foto" — atendente envia uma foto do computador via upload.
describe("POST /api/catalogo/produtos/:codigo/fotos/upload", () => {
  beforeEach(() => jest.clearAllMocks());

  test("sem arquivo → 400, não chama o service", async () => {
    const res = await request(buildApp()).post("/api/catalogo/produtos/P1/fotos/upload");
    expect(res.status).toBe(400);
    expect(adicionarFotoManual).not.toHaveBeenCalled();
  });

  test("código inválido → 400, não chama o service", async () => {
    const res = await request(buildApp())
      .post("/api/catalogo/produtos/P!1/fotos/upload")
      .attach("foto", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "foto.jpg");
    expect(res.status).toBe(400);
    expect(adicionarFotoManual).not.toHaveBeenCalled();
  });

  test("arquivo JPG válido → 200, repassa o buffer pro service", async () => {
    adicionarFotoManual.mockReturnValue([{ indice: 0, nomeArquivo: "123-abc.jpg", oculta: false, manual: true }]);
    const res = await request(buildApp())
      .post("/api/catalogo/produtos/P1/fotos/upload")
      .attach("foto", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "foto.jpg");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.fotos).toEqual([{ indice: 0, nomeArquivo: "123-abc.jpg", oculta: false, manual: true }]);
    expect(adicionarFotoManual).toHaveBeenCalledWith("P1", expect.any(Buffer));
  });

  test("service rejeita arquivo (erro de negócio) → 400", async () => {
    adicionarFotoManual.mockImplementation(() => {
      throw new Error("Não consegui reconhecer esse arquivo como uma foto JPG ou PNG válida.");
    });
    const res = await request(buildApp())
      .post("/api/catalogo/produtos/P1/fotos/upload")
      .attach("foto", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "foto.jpg");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPG ou PNG/);
  });

  test("mimetype não permitido (fileFilter do multer) → rejeitado", async () => {
    const res = await request(buildApp())
      .post("/api/catalogo/produtos/P1/fotos/upload")
      .attach("foto", Buffer.from("não é imagem"), { filename: "arquivo.txt", contentType: "text/plain" });
    expect(res.status).not.toBe(200);
    expect(adicionarFotoManual).not.toHaveBeenCalled();
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
