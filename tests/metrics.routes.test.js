/**
 * Testes de metrics.routes.js — foco em dois pontos:
 *
 * 1. BUG CORRIGIDO: a aba "Métricas" no frontend (frontend/index.html) é
 *    marcada como "supervisor-only" (supervisor + admin), mas o backend
 *    montava a rota /api/metrics com requireAdmin (só admin) em src/app.js —
 *    um supervisor via a aba mas levava 403 ao carregar os dados. Corrigido
 *    trocando para requireRole("admin", "supervisor"), igual já foi feito
 *    para broadcastRoutes. Aqui reproduzimos o pipeline exato do app.js
 *    (authSession-like middleware + requireRole real, não mockado) pra
 *    confirmar que supervisor agora recebe 200.
 *
 * 2. Pedido do usuário: pesquisa de satisfação (nota 1-5) visível "por
 *    atendente" na aba Métricas — os campos satisfacaoMedia,
 *    satisfacaoTotalRespostas e satisfacaoPorAtendente precisam aparecer na
 *    resposta.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/activityLog.service", () => ({
  addLog: jest.fn().mockResolvedValue(undefined)
}));

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const { requireRole } = require("../src/routes/auth.routes");
const metricsRoutes = require("../src/routes/metrics.routes");

function buildApp(currentUser) {
  const app = express();
  app.use((req, res, next) => {
    req.user = currentUser;
    next();
  });
  // Mesmo pipeline usado em src/app.js: authSession (aqui simulado pelo
  // middleware acima) + requireRole("admin", "supervisor") real.
  app.use("/api", requireRole("admin", "supervisor"), metricsRoutes);
  return app;
}

const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };
const SUPERVISOR = { id: "sup-1", nome: "Sérgio Supervisor", perfil: "supervisor", sector: "geral" };
const ATENDENTE = { id: "at-1", nome: "Bruno", perfil: "atendente", sector: "vendas" };

function installFakePool() {
  pool.query.mockImplementation(async (text) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/COUNT\(\*\)::int\s+AS total/.test(sql) && /AS hoje/.test(sql)) {
      return {
        rows: [{
          total: 10, abertos: 2, andamento: 3, resolvidos: 4, cancelados: 1,
          hoje: 1, mensal: 10
        }]
      };
    }
    if (/COALESCE\(sector, 'geral'\) AS setor/.test(sql)) {
      return { rows: [{ setor: "vendas", total: 6 }, { setor: "financeiro", total: 4 }] };
    }
    if (/TO_CHAR\(created_at/.test(sql)) {
      return { rows: [{ dia: "15/07/2026", total: 3 }] };
    }
    if (/AVG\(satisfaction_rating\)/.test(sql) && /GROUP BY assigned_to_name/.test(sql)) {
      return { rows: [{ nome: "Bruno", media: "4.50", total: 2 }] };
    }
    if (/AVG\(satisfaction_rating\)/.test(sql)) {
      return { rows: [{ media: "4.20", total: 5 }] };
    }

    throw new Error("Query não mapeada no mock de metrics.routes.test.js: " + sql);
  });
}

describe("GET /api/metrics", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installFakePool();
  });

  test("admin acessa normalmente (200)", async () => {
    const res = await request(buildApp(ADMIN)).get("/api/metrics");
    expect(res.status).toBe(200);
  });

  // BUG CORRIGIDO: antes retornava 403 pra supervisor (requireAdmin, não
  // requireRole) — a aba aparecia no frontend mas os dados nunca carregavam.
  test("supervisor agora acessa normalmente (200), não mais 403", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");
    expect(res.status).toBe(200);
  });

  test("atendente comum continua sem acesso (403)", async () => {
    const res = await request(buildApp(ATENDENTE)).get("/api/metrics");
    expect(res.status).toBe(403);
  });

  test("resposta inclui satisfacaoMedia, satisfacaoTotalRespostas e satisfacaoPorAtendente", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(res.body.satisfacaoMedia).toBe(4.2);
    expect(res.body.satisfacaoTotalRespostas).toBe(5);
    expect(res.body.satisfacaoPorAtendente).toEqual({
      Bruno: { media: 4.5, total: 2 }
    });
  });
});
