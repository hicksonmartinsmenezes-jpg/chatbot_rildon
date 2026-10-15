/**
 * Pedido do usuário (2026-10-15): exportar os atendimentos em planilha e
 * relatório por intervalo livre de datas. Cobre a rota de CSV (cabeçalho,
 * separador, escape e proteção contra fórmula) e o repasse de ?de=&ate=.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/activityLog.service", () => ({ addLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/services/metrics.service", () => ({
  buscarMetricas: jest.fn().mockResolvedValue({ mesRef: null }),
  listarAtendimentosDoPeriodo: jest.fn().mockResolvedValue([])
}));

const express = require("express");
const request = require("supertest");
const { buscarMetricas, listarAtendimentosDoPeriodo } = require("../src/services/metrics.service");
const metricsRoutes = require("../src/routes/metrics.routes");

function app() {
  const a = express();
  a.use((req, res, next) => { req.user = { id: "1", nome: "Ana", perfil: "admin" }; next(); });
  a.use("/api", metricsRoutes);
  return a;
}

const LINHA = {
  protocolo: "2026-0001", cliente: 'Loja "do Zé"', contato: "5579@s.whatsapp.net",
  tipo: "geral", setor: "vendas", status: "resolvido", atendente: "Rafael",
  aberto_em: "01/09/2026 09:00", assumido_em: "01/09/2026 09:05", fechado_em: "01/09/2026 09:40",
  espera_min: "5.0", duracao_min: "40.0", nota: 5, comentario: "=SOMA(A1)"
};

describe("GET /api/metrics/exportar-csv", () => {
  beforeEach(() => jest.clearAllMocks());

  test("devolve CSV com BOM, cabeçalho e separador ;", async () => {
    listarAtendimentosDoPeriodo.mockResolvedValueOnce([LINHA]);
    const res = await request(app()).get("/api/metrics/exportar-csv?mes=2026-09");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain("atendimentos-2026-09.csv");
    expect(res.text.startsWith("﻿")).toBe(true);
    expect(res.text).toContain('"Protocolo";"Cliente"');
    expect(res.text).toContain('"2026-0001"');
  });

  test("escapa aspas e neutraliza fórmula do Excel", async () => {
    listarAtendimentosDoPeriodo.mockResolvedValueOnce([LINHA]);
    const res = await request(app()).get("/api/metrics/exportar-csv?mes=2026-09");

    expect(res.text).toContain('"Loja ""do Zé"""');
    expect(res.text).toContain(`"'=SOMA(A1)"`);
  });

  test("intervalo livre vai para o service e nomeia o arquivo", async () => {
    const res = await request(app()).get("/api/metrics/exportar-csv?de=2026-09-01&ate=2026-09-15");

    expect(listarAtendimentosDoPeriodo).toHaveBeenCalledWith(
      expect.objectContaining({ de: "2026-09-01", ate: "2026-09-15", mes: null })
    );
    expect(res.headers["content-disposition"]).toContain("atendimentos-2026-09-01_a_2026-09-15.csv");
  });

  test("intervalo invertido é ignorado e cai no recorte mensal", async () => {
    await request(app()).get("/api/metrics/exportar-csv?de=2026-09-30&ate=2026-09-01&mes=2026-08");
    expect(listarAtendimentosDoPeriodo).toHaveBeenCalledWith(
      expect.objectContaining({ mes: "2026-08", de: undefined, ate: undefined })
    );
  });

  test("filtro por atendente só aceita uuid", async () => {
    await request(app()).get("/api/metrics/exportar-csv?mes=2026-09&atendente=11111111-2222-3333-4444-555555555555");
    expect(listarAtendimentosDoPeriodo).toHaveBeenCalledWith(
      expect.objectContaining({ atendente: "11111111-2222-3333-4444-555555555555" })
    );
    jest.clearAllMocks();
    await request(app()).get("/api/metrics/exportar-csv?mes=2026-09&atendente=qualquer-coisa");
    expect(listarAtendimentosDoPeriodo).toHaveBeenCalledWith(expect.objectContaining({ atendente: null }));
  });
});

describe("GET /api/metrics — intervalo livre", () => {
  beforeEach(() => jest.clearAllMocks());

  test("repassa { de, ate } quando as duas datas vêm", async () => {
    await request(app()).get("/api/metrics?de=2026-09-01&ate=2026-09-15");
    expect(buscarMetricas).toHaveBeenCalledWith({ de: "2026-09-01", ate: "2026-09-15" });
  });

  test("sem intervalo completo, continua pelo mês", async () => {
    await request(app()).get("/api/metrics?de=2026-09-01&mes=2026-08");
    expect(buscarMetricas).toHaveBeenCalledWith("2026-08");
  });
});
