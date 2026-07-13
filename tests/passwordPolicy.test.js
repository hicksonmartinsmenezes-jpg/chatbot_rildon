/**
 * Testes de validarForcaSenha — política atual (2026-07-13): PIN numérico
 * de exatamente 4 dígitos, para todos os perfis (inclusive admin). Trocado
 * a pedido explícito do usuário a partir da política anterior (mín. 10
 * caracteres + 3 das 4 classes de caractere) — ver comentário em
 * src/utils/passwordPolicy.js para o histórico e a mitigação (loginLimiter)
 * que continua em vigor dado o espaço de senha bem menor.
 */
const { validarForcaSenha, PIN_LENGTH } = require("../src/utils/passwordPolicy");

describe("validarForcaSenha", () => {
  test("aceita PIN de 4 dígitos que não é óbvio", () => {
    const r = validarForcaSenha("4821");
    expect(r.valido).toBe(true);
    expect(r.erro).toBeNull();
  });

  test("rejeita PIN mais curto que 4 dígitos", () => {
    const r = validarForcaSenha("482");
    expect(r.valido).toBe(false);
    expect(r.erro).toMatch(new RegExp(String(PIN_LENGTH)));
  });

  test("rejeita PIN mais longo que 4 dígitos", () => {
    const r = validarForcaSenha("48212");
    expect(r.valido).toBe(false);
  });

  test("rejeita senha com letras/símbolos (não é só dígitos)", () => {
    const r = validarForcaSenha("Ab1!");
    expect(r.valido).toBe(false);
  });

  test("rejeita PINs óbvios/sequenciais mesmo com 4 dígitos", () => {
    expect(validarForcaSenha("0000").valido).toBe(false);
    expect(validarForcaSenha("1234").valido).toBe(false);
    expect(validarForcaSenha("1234").erro).toMatch(/óbvio|sequencial/i);
  });

  test("trata entrada vazia/undefined sem lançar exceção", () => {
    expect(validarForcaSenha(undefined).valido).toBe(false);
    expect(validarForcaSenha("").valido).toBe(false);
  });
});
