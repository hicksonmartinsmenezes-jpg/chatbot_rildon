/**
 * Testes de history.repository.js — foco em findGroupedByUser().
 *
 * BUG CORRIGIDO (usuário: "sinto que não está salvando todas as
 * conversas"): o painel de Histórico buscava um recorte plano das N
 * mensagens mais recentes de TODA A LOJA (findAll com LIMIT baixo) e
 * agrupava por cliente no navegador — clientes com conversas mais antigas
 * simplesmente somem da lista assim que a loja ultrapassa esse total.
 * findGroupedByUser() resolve isso no banco: DISTINCT ON (user_id) pega só
 * a linha mais recente por cliente, e COUNT(*) OVER (PARTITION BY user_id)
 * traz o total de interações daquele cliente sem precisar de uma segunda
 * query — mesmo padrão já usado em getConversationsHandler (history.controller.js).
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const repo = require("../src/repositories/history.repository");

describe("history.repository — findGroupedByUser", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sem filtros: usa LIMIT/OFFSET padrão e nenhum WHERE", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await repo.findGroupedByUser({});

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/DISTINCT ON \(user_id\)/);
    expect(sql).toMatch(/COUNT\(\*\) OVER \(PARTITION BY user_id\)/);
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([500, 0]); // limit padrão 500, offset 0
  });

  test("com busca (q) e intervalo de datas: monta WHERE com os placeholders certos", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await repo.findGroupedByUser({ q: "audi", from: "2026-07-01", to: "2026-07-17", limit: 50, offset: 10 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE/);
    expect(sql).toMatch(/user_id ILIKE \$1 OR contact_name ILIKE \$2 OR message ILIKE \$3 OR response ILIKE \$4/);
    expect(sql).toMatch(/created_at AT TIME ZONE .+ >= \$5::date/);
    expect(sql).toMatch(/created_at AT TIME ZONE .+ <= \$6::date/);
    expect(params).toEqual(["%audi%", "%audi%", "%audi%", "%audi%", "2026-07-01", "2026-07-17", 50, 10]);
  });

  test("mapeia o total_count da window function para o campo 'count' de cada cliente", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 10, user_id: "u1@s.whatsapp.net", contact_name: "Ana", message: "oi", response: "olá", sector: "vendas", status: null, message_id: "m1", created_at: new Date(), total_count: "7" },
        { id: 20, user_id: "u2@s.whatsapp.net", contact_name: "Bruno", message: "oi", response: "olá", sector: "geral", status: null, message_id: "m2", created_at: new Date(), total_count: "1" },
      ],
    });

    const result = await repo.findGroupedByUser({});

    expect(result).toEqual([
      expect.objectContaining({ userId: "u1@s.whatsapp.net", count: 7 }),
      expect.objectContaining({ userId: "u2@s.whatsapp.net", count: 1 }),
    ]);
  });

  test("respeita limit/offset customizados nos parâmetros finais da query", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await repo.findGroupedByUser({ limit: 2000, offset: 100 });

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([2000, 100]);
  });
});
