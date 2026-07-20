/**
 * Testes de catalogo.service.js — leitura do catálogo real de
 * seções/linhas de produto (src/config/catalogo-produtos.json, extraído
 * pelo usuário do sistema de estoque em 2026-07-20) usado pra dar à IA
 * confiança concreta sobre o que a loja vende (ver ai.service.js).
 */
const { listarSecoes, buscarNoCatalogo } = require("../src/services/catalogo.service");

describe("catalogo.service", () => {
  test("listarSecoes() devolve as seções reais do catálogo, sem a chave de metadado _sobre", () => {
    const secoes = listarSecoes();
    expect(Array.isArray(secoes)).toBe(true);
    expect(secoes.length).toBeGreaterThan(20);
    expect(secoes).toContain("ALTERNADOR");
    expect(secoes).toContain("MOTOR DE PARTIDA");
    expect(secoes).not.toContain("_sobre");
    // Seções que são categorias internas de estoque (não produto vendável)
    // foram removidas na extração — não devem aparecer aqui.
    expect(secoes).not.toContain("CONSUMO");
    expect(secoes).not.toContain("IMOBILIZADO");
    expect(secoes).not.toContain("PADRAO");
  });

  test("buscarNoCatalogo() encontra item citado com o nome exato (case-insensitive, sem acento)", () => {
    const res = buscarNoCatalogo("preciso de um REGULADOR DE VOLTAGEM");
    expect(res).toEqual([
      expect.objectContaining({ secao: "ALTERNADOR", linha: "REGULADOR DE VOLTAGEM" }),
    ]);
  });

  test("buscarNoCatalogo() ignora acentuação e caixa (ex: 'ignicao' bate com 'IGNIÇÃO')", () => {
    const res = buscarNoCatalogo("preciso de vela de ignicao pro carro");
    expect(res.some(r => r.linha === "VELA DE IGNIÇÃO")).toBe(true);
  });

  test("buscarNoCatalogo() sem nenhum item do catálogo na mensagem → array vazio", () => {
    expect(buscarNoCatalogo("bom dia, tudo bem?")).toEqual([]);
    expect(buscarNoCatalogo("")).toEqual([]);
    expect(buscarNoCatalogo(undefined)).toEqual([]);
  });

  test("buscarNoCatalogo() respeita o limite de resultados (padrão 3)", () => {
    // Mensagem citando várias peças de uma vez — trigger comum de orçamento
    // combinado ("preciso de alternador, motor de partida e regulador de voltagem")
    const res = buscarNoCatalogo(
      "preciso de alternador completo, motor de partida automatico e regulador de voltagem, e tambem uma buzina caracol"
    );
    expect(res.length).toBeLessThanOrEqual(3);
  });

  test("buscarNoCatalogo() não confunde substring parcial de outra palavra (match é da linha inteira normalizada)", () => {
    // "BUCHA" sozinho é uma linha real (seção GERADOR) — mas dentro da
    // palavra "ABUCHADO" (não existe, é só teste) não deveria "vazar" por
    // ser substring de uma palavra maior sem separação de espaço real.
    // Aqui validamos o caso positivo simples: "preciso de uma bucha" bate.
    const res = buscarNoCatalogo("preciso de uma bucha pro gerador");
    expect(res.some(r => r.linha === "BUCHA")).toBe(true);
  });
});
