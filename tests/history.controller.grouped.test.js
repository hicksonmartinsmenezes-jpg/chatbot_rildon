/**
 * Testes de history.controller.js — getHistoryGroupedHandler().
 *
 * Ver tests/history.repository.grouped.test.js para o contexto do bug
 * corrigido ("sinto que não está salvando todas as conversas" — na
 * verdade era o painel só buscando as N mensagens mais recentes de TODA a
 * loja, sem agrupar/paginar corretamente por cliente).
 */
jest.mock("../src/services/history.service", () => ({
  listHistory: jest.fn(),
  listHistoryGrouped: jest.fn(),
  getHistoryGroupedSummary: jest.fn(),
}));

const { listHistoryGrouped, getHistoryGroupedSummary } = require("../src/services/history.service");
const { getHistoryGroupedHandler } = require("../src/controllers/history.controller");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("history.controller — getHistoryGroupedHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getHistoryGroupedSummary.mockResolvedValue({
      totalClientes: 1,
      totalRegistros: 3,
      hoje: 0,
      comResposta: 2,
    });
  });

  test("repassa q/from/to e aplica limite padrão de 40 quando não informado", async () => {
    listHistoryGrouped.mockResolvedValue([{ userId: "u1", count: 3 }]);
    const req = { query: {} };
    const res = mockRes();

    await getHistoryGroupedHandler(req, res);

    expect(listHistoryGrouped).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 40, offset: 0 })
    );
    expect(getHistoryGroupedSummary).toHaveBeenCalledWith({
      q: undefined, from: undefined, to: undefined, horaInicio: undefined, horaFim: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      page: 1,
      limit: 40,
      total: 1,
      count: 1,
      data: [{ userId: "u1", count: 3 }],
      summary: { totalClientes: 1, totalRegistros: 3, hoje: 0, comResposta: 2 },
    });
  });

  test("respeita limit customizado, mas nunca deixa passar de 2000 (teto de segurança)", async () => {
    listHistoryGrouped.mockResolvedValue([]);
    const req = { query: { limit: "99999" } };
    const res = mockRes();

    await getHistoryGroupedHandler(req, res);

    expect(listHistoryGrouped).toHaveBeenCalledWith(expect.objectContaining({ limit: 2000 }));
    expect(res.json.mock.calls[0][0]).toMatchObject({ limit: 2000 });
  });

  test("repassa filtros de busca e data ao service", async () => {
    listHistoryGrouped.mockResolvedValue([]);
    const req = { query: { q: "audi", from: "2026-07-01", to: "2026-07-17" } };
    const res = mockRes();

    await getHistoryGroupedHandler(req, res);

    expect(listHistoryGrouped).toHaveBeenCalledWith(
      expect.objectContaining({ q: "audi", from: "2026-07-01", to: "2026-07-17" })
    );
    expect(getHistoryGroupedSummary).toHaveBeenCalledWith(expect.objectContaining({
      q: "audi", from: "2026-07-01", to: "2026-07-17",
    }));
  });

  test("erro no service não derruba a rota — responde 500 com lista vazia", async () => {
    getHistoryGroupedSummary.mockRejectedValue(new Error("db offline"));
    const req = { query: {} };
    const res = mockRes();

    await getHistoryGroupedHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      page: 1,
      limit: 40,
      total: 0,
      count: 0,
      data: [],
      summary: { totalClientes: 0, totalRegistros: 0, hoje: 0, comResposta: 0 },
    });
  });
});
