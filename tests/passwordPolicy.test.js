/**
 * Testes de validarForcaSenha — política aplicada em toda criação/troca de
 * senha (criação de usuário, reset por admin, troca pelo próprio usuário e
 * o bootstrap do primeiro admin em scripts/create-admin.js). O ponto
 * sensível é não deixar passar senhas "tecnicamente longas" mas fracas
 * (ex: só minúsculas, ou uma senha comum conhecida).
 */
const { validarForcaSenha, MIN_LENGTH, MIN_CLASSES } = require("../src/utils/passwordPolicy");

describe("validarForcaSenha", () => {
  test("rejeita senha mais curta que o mínimo", () => {
    const r = validarForcaSenha("Abc123!");
    expect(r.valido).toBe(false);
    expect(r.erro).toMatch(new RegExp(String(MIN_LENGTH)));
  });

  test("rejeita senha longa mas com só uma classe de caractere", () => {
    const r = validarForcaSenha("aaaaaaaaaaaaaaaa");
    expect(r.valido).toBe(false);
  });

  test(`rejeita senha com só 2 das ${MIN_CLASSES} classes exigidas`, () => {
    const r = validarForcaSenha("abcdefghij123456"); // minúscula + dígito, sem maiúscula/símbolo
    expect(r.valido).toBe(false);
  });

  test("rejeita senha comum conhecida mesmo atendendo tamanho/complexidade", () => {
    const r = validarForcaSenha("Password123");
    expect(r.valido).toBe(false);
    expect(r.erro).toMatch(/comum/i);
  });

  test("aceita senha que atende tamanho + 3 classes e não é comum", () => {
    const r = validarForcaSenha("SenhaForte123");
    expect(r.valido).toBe(true);
    expect(r.erro).toBeNull();
  });

  test("aceita senha com as 4 classes", () => {
    const r = validarForcaSenha("Rild0n#Peca2026");
    expect(r.valido).toBe(true);
  });

  test("trata entrada vazia/undefined sem lançar exceção", () => {
    expect(validarForcaSenha(undefined).valido).toBe(false);
    expect(validarForcaSenha("").valido).toBe(false);
  });
});
