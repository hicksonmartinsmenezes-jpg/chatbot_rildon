/**
 * Testes de src/whatsapp/lid-map.js — foco em canonicalizeUserId(), criada
 * pra resolver o bug #96 (cliente aparecendo duas vezes na lista de
 * conversas do painel / ticketsByUser não batendo com a conversa).
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const { setLidMapping, canonicalizeUserId } = require("../src/whatsapp/lid-map");

describe("lid-map — canonicalizeUserId", () => {
  beforeEach(() => {
    // setLidMapping tenta persistir no banco (INSERT INTO lid_map) — sem um
    // valor resolvido aqui, pool.query(...) volta undefined e o .catch()
    // interno explode antes mesmo do teste rodar.
    pool.query.mockResolvedValue({ rows: [] });
  });

  test("@lid com jid conhecido → devolve o jid resolvido", () => {
    const lid = "123123123123123@lid";
    const jid = "5511911112222@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    expect(canonicalizeUserId(lid)).toBe(jid);
  });

  test("@lid SEM jid conhecido → devolve o próprio @lid intocado", () => {
    expect(canonicalizeUserId("999999999999999@lid")).toBe("999999999999999@lid");
  });

  test("já é @s.whatsapp.net → passa direto, sem tentar resolver nada", () => {
    expect(canonicalizeUserId("5511900000000@s.whatsapp.net")).toBe("5511900000000@s.whatsapp.net");
  });

  // Risco real detectado ao implementar: canonicalizeUserId não pode
  // reaproveitar normalizeJid() aqui, porque normalizeJid extrai dígitos e
  // monta "...@s.whatsapp.net" mesmo de strings que não são um id de
  // WhatsApp de verdade — isso mangla ids de teste usados em todo o resto
  // da suite (ex: "u1", "cliente-x") e mudaria silenciosamente o
  // comportamento de várias rotas em produção também, caso um userId chegue
  // sem o sufixo esperado por qualquer motivo.
  test("valor sem sufixo de WhatsApp (ex: id de teste) passa intocado, sem virar um jid fabricado", () => {
    expect(canonicalizeUserId("u1")).toBe("u1");
    expect(canonicalizeUserId("cliente-x")).toBe("cliente-x");
  });

  test("valor vazio/nulo não quebra", () => {
    expect(canonicalizeUserId("")).toBe("");
    expect(canonicalizeUserId(null)).toBe("");
    expect(canonicalizeUserId(undefined)).toBe("");
  });
});
