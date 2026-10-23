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

  test("versão persiste e muda quando os prontos são descartados", () => {
    const v1 = prontos.versao();
    expect(v1).toMatch(/^\d+$/);
    expect(prontos.versao()).toBe(v1);
    const antes = Date.now();
    while (Date.now() === antes) { /* garante timestamp diferente */ }
    prontos.limparTodos();
    expect(prontos.versao()).not.toBe(v1);
  });
});

// Varredura 2026-10-23: o contêiner roda em UTC, então a regra "segunda às 20h" estava
// disparando às 17h da loja. A hora passou a ser lida no fuso da loja — isto trava a conversão.
describe("catalogo-prontos: horário da loja", () => {
  const { agoraNaLoja } = require("../src/services/catalogo-prontos.service");

  test("segunda 23h UTC é segunda 20h na loja", () => {
    const naLoja = agoraNaLoja(new Date("2026-10-26T23:00:00Z"));
    expect(naLoja.getHours()).toBe(20);
    expect(naLoja.getDay()).toBe(1); // segunda-feira
  });

  test("segunda 20h UTC ainda é 17h na loja (o caso que estava errado)", () => {
    expect(agoraNaLoja(new Date("2026-10-26T20:00:00Z")).getHours()).toBe(17);
  });

  test("vira o dia certo: terça 01h UTC é segunda 22h na loja", () => {
    const naLoja = agoraNaLoja(new Date("2026-10-27T01:00:00Z"));
    expect(naLoja.getDay()).toBe(1);
    expect(naLoja.getHours()).toBe(22);
  });
});
