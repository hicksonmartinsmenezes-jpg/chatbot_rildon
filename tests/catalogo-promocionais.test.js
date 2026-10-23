const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promos-"));
process.env.CATALOGOS_PRONTOS_DIR = tmp;
const promocionais = require("../src/services/catalogo-promocionais.service");
const { ROTAS_LEITURA, ROTAS_ESCRITA, ROTAS_APAGAR } = require("../src/middlewares/catalogo-consulta");

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("catalogo-promocionais.service", () => {
  test("lista vazia quando a pasta ainda não existe", () => {
    expect(promocionais.listar()).toEqual([]);
  });

  test("gera, lista, abre e remove um catálogo", async () => {
    const d = promocionais.novoDestino();
    d.stream.end("%PDF-1.4 teste");
    const item = await d.publicar({ nome: "  Promoção   de Outubro ", itens: 3, modo: "fabricante" });
    expect(item.id).toBe(d.id);
    expect(item.nome).toBe("Promoção de Outubro");

    const lista = promocionais.listar();
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ id: d.id, nome: "Promoção de Outubro", itens: 3, modo: "fabricante" });
    expect(fs.readFileSync(promocionais.caminhoPdf(d.id), "utf8")).toContain("%PDF");

    expect(promocionais.remover(d.id)).toBe(true);
    expect(promocionais.listar()).toEqual([]);
    expect(promocionais.caminhoPdf(d.id)).toBeNull();
    expect(promocionais.remover(d.id)).toBe(false);
  });

  test("emPromocao: produto aparece enquanto o catálogo existir", async () => {
    expect(promocionais.emPromocao("P1")).toBe(false);
    const d = promocionais.novoDestino();
    d.stream.end("%PDF");
    await d.publicar({ nome: "Promo", itens: 2, codigos: ["P1", 22], precos: { P1: 9.9, 22: null } });
    expect(promocionais.emPromocao("P1")).toBe(true);
    expect(promocionais.emPromocao(22)).toBe(true);
    expect(promocionais.emPromocao("P9")).toBe(false);
    expect(promocionais.infoPromocao("P1")).toEqual({ promocao: true, precoPromocao: 9.9 });
    expect(promocionais.infoPromocao(22)).toEqual({ promocao: true, precoPromocao: null });
    expect(promocionais.infoPromocao("P9")).toEqual({ promocao: false, precoPromocao: null });
    promocionais.remover(d.id);
    expect(promocionais.emPromocao("P1")).toBe(false);
  });

  test("PDF vazio não vira catálogo", async () => {
    const d = promocionais.novoDestino();
    d.stream.end();
    await expect(d.publicar({ nome: "x", itens: 0 })).rejects.toThrow();
    expect(promocionais.listar()).toEqual([]);
  });

  test("ids com caminho/aspas são recusados", () => {
    for (const id of ["../x", "a/b", "ABC", "", "a b c d e f", null, undefined]) {
      expect(promocionais.caminhoPdf(id)).toBeNull();
      expect(promocionais.remover(id)).toBe(false);
    }
  });

  test("nome vazio recebe um padrão", async () => {
    const d = promocionais.novoDestino();
    d.stream.end("%PDF");
    const item = await d.publicar({ nome: "   ", itens: 1 });
    expect(item.nome).toBe("Catálogo promocional");
    promocionais.remover(d.id);
  });
});

describe("programa da loja: rotas liberadas sem login", () => {
  const casa = (lista, p) => lista.some((re) => re.test(p));
  test("lista e PDF (GET)", () => {
    expect(casa(ROTAS_LEITURA, "/catalogo/exe-versao")).toBe(true);
    expect(casa(ROTAS_LEITURA, "/catalogo/exe-download")).toBe(true);
    expect(casa(ROTAS_ESCRITA, "/catalogo/exe-download")).toBe(false);
    expect(casa(ROTAS_LEITURA, "/catalogo/promocionais")).toBe(true);
    expect(casa(ROTAS_LEITURA, "/catalogo/promocionais/abc123x/pdf")).toBe(true);
    expect(casa(ROTAS_LEITURA, "/catalogo/promocionais/../x/pdf")).toBe(false);
  });
  test("apagar (DELETE) e gerar (POST)", () => {
    expect(casa(ROTAS_APAGAR, "/catalogo/promocionais/abc123x")).toBe(true);
    expect(casa(ROTAS_APAGAR, "/catalogo/produtos/X/linha")).toBe(false);
    expect(casa(ROTAS_ESCRITA, "/catalogo/promocional/exportar-pdf")).toBe(true);
    expect(casa(ROTAS_ESCRITA, "/estoque/recarregar")).toBe(false);
  });
});
