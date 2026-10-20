const fs = require("fs");
const os = require("os");
const path = require("path");

describe("catalogo-prontos.service", () => {
  let prontos;
  beforeAll(() => {
    process.env.CATALOGOS_PRONTOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "prontos-"));
    prontos = require("../src/services/catalogo-prontos.service");
  });

  test("não existe até publicar; depois existe", async () => {
    expect(prontos.existe("PERFECT::mecanica")).toBe(false);
    const d = prontos.novoDestino("PERFECT::mecanica");
    d.stream.end("%PDF-teste");
    await d.publicar();
    expect(prontos.existe("PERFECT::mecanica")).toBe(true);
    expect(prontos.existe("OUTRO")).toBe(false);
  });

  test("arquivo vazio não conta como pronto", async () => {
    const d = prontos.novoDestino("VAZIO");
    d.stream.end();
    await d.publicar();
    expect(prontos.existe("VAZIO")).toBe(false);
  });

  test("chaves parecidas geram arquivos diferentes", () => {
    expect(prontos.arquivo("A B")).not.toBe(prontos.arquivo("A-B"));
  });

  test("limparTodos apaga os prontos", () => {
    expect(prontos.limparTodos()).toBeGreaterThan(0);
    expect(prontos.existe("PERFECT::mecanica")).toBe(false);
  });
});
