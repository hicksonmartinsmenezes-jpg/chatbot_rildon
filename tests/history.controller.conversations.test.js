/**
 * Testes de history.controller.js — getConversationsHandler().
 *
 * BUG CORRIGIDO (#96): o mesmo cliente real pode ter linhas em `history`
 * salvas com o user_id em DOIS formatos — "...@lid" (dispositivo vinculado,
 * ver LID_FALLBACK em src/config/whatsapp.js) e já resolvido para
 * "...@s.whatsapp.net". Como a query original fazia DISTINCT ON (user_id)
 * LITERAL, esse cliente virava DUAS linhas na lista de conversas do painel —
 * e pior, o frontend cruza essa lista com GET /api/tickets por userId
 * (ticketsByUser[userId] em frontend/js/07-conversations.js): se o ticket
 * estiver salvo sob o formato OPOSTO, a conversa aparecia como "sem ticket"
 * mesmo já tendo um.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const { setLidMapping } = require("../src/whatsapp/lid-map");
const { getConversationsHandler } = require("../src/controllers/history.controller");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function row(overrides = {}) {
  return {
    id: 1,
    user_id: "5511900000000@s.whatsapp.net",
    contact_name: "Cliente",
    message: "oi",
    response: "olá",
    sector: "geral",
    status: null,
    message_id: "m1",
    created_at: new Date("2026-07-17T10:00:00Z"),
    ...overrides
  };
}

describe("history.controller — getConversationsHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default resolvido pra qualquer query (inclusive o INSERT INTO lid_map
    // disparado por setLidMapping) — cada teste sobrescreve com os rows que
    // interessam antes de chamar o handler.
    pool.query.mockResolvedValue({ rows: [] });
  });

  test("cliente com histórico em formato @lid e @s.whatsapp.net — colapsa em UMA conversa só, com o jid resolvido", async () => {
    const lid = "600700800900100@lid";
    const jid = "5511988889999@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    // A query já vem ordenada por created_at DESC — a linha do @lid é a mais recente.
    pool.query.mockResolvedValue({
      rows: [
        row({ id: 2, user_id: lid, message: "mensagem mais recente", created_at: new Date("2026-07-17T12:00:00Z") }),
        row({ id: 1, user_id: jid, message: "mensagem mais antiga", created_at: new Date("2026-07-17T09:00:00Z") }),
      ]
    });

    const req = { query: {} };
    const res = mockRes();
    await getConversationsHandler(req, res);

    const rows = res.json.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: jid, message: "mensagem mais recente" });
  });

  test("clientes diferentes (sem relação lid/jid) continuam separados normalmente", async () => {
    pool.query.mockResolvedValue({
      rows: [
        row({ id: 1, user_id: "5511900000001@s.whatsapp.net" }),
        row({ id: 2, user_id: "5511900000002@s.whatsapp.net" }),
      ]
    });

    const req = { query: {} };
    const res = mockRes();
    await getConversationsHandler(req, res);

    const rows = res.json.mock.calls[0][0];
    expect(rows).toHaveLength(2);
  });

  test("@lid sem mapeamento conhecido não é mesclado com nada — aparece como está", async () => {
    pool.query.mockResolvedValue({
      rows: [row({ id: 1, user_id: "999888777666555@lid" })]
    });

    const req = { query: {} };
    const res = mockRes();
    await getConversationsHandler(req, res);

    const rows = res.json.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("999888777666555@lid");
  });

  test("erro na query não derruba a rota — responde 500 com lista vazia", async () => {
    pool.query.mockRejectedValue(new Error("db offline"));
    const req = { query: {} };
    const res = mockRes();

    await getConversationsHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith([]);
  });
});
