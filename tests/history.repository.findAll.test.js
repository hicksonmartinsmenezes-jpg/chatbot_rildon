/**
 * Testes de history.repository.js — findAll(), foco no filtro por userId.
 *
 * BUG CORRIGIDO (#96): abrir a conversa de um cliente (GET /api/history?
 * userId=X) usava match EXATO (`user_id = $1`). Se X é o jid canônico (ver
 * canonicalizeUserId em getConversationsHandler) mas parte das mensagens
 * antigas desse mesmo cliente ficou salva sob o formato "...@lid" original
 * (ver LID_FALLBACK em src/config/whatsapp.js), essas mensagens somem da
 * conversa aberta no painel — mostra só uma FATIA do histórico real.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const { setLidMapping } = require("../src/whatsapp/lid-map");
const { findAll } = require("../src/repositories/history.repository");

describe("history.repository — findAll (filtro por userId)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default resolvido pra qualquer query (inclusive o INSERT INTO lid_map
    // disparado por setLidMapping) — cada teste sobrescreve antes de chamar findAll.
    pool.query.mockResolvedValue({ rows: [] });
  });

  test("userId com mapeamento lid/jid conhecido busca em TODOS os formatos equivalentes", async () => {
    const lid = "111222333444555@lid";
    const jid = "5511977776666@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    pool.query.mockResolvedValue({ rows: [] });

    await findAll({ userId: jid });

    const [sql, params] = pool.query.mock.calls.find(([s]) => /FROM history/.test(s));
    expect(sql).toMatch(/user_id = ANY\(\$1::text\[\]\)/);
    expect(params[0]).toEqual(expect.arrayContaining([jid, lid]));
  });

  test("userId sem nenhum mapeamento conhecido ainda assim monta a cláusula ANY (com só ele mesmo)", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await findAll({ userId: "5511900000000@s.whatsapp.net" });

    const [sql, params] = pool.query.mock.calls.find(([s]) => /FROM history/.test(s));
    expect(sql).toMatch(/user_id = ANY\(\$1::text\[\]\)/);
    expect(params[0]).toContain("5511900000000@s.whatsapp.net");
  });

  test("sem userId: não monta WHERE nenhum por usuário", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await findAll({});

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/user_id/);
  });
});
