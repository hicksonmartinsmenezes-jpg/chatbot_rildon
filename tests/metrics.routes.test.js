/**
 * Testes de metrics.routes.js — foco em três pontos:
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
 *
 * 3. PEDIDO DO USUÁRIO (2026-07-27): reformulação da aba Métricas pra
 *    supervisora monitorar "quem está em atendimento/quem não" e "quem
 *    atendeu mais" — campos "atendentes" (total atendido + em_andamento
 *    agora) e "horarioPico"/"porHora" (pra decidir escala). Os antigos
 *    "porStatus"/"porSetor"/"setorMaisMovimentado" foram removidos a pedido
 *    do usuário (a aba Métricas não mostra mais esses gráficos/card).
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
    if (/TO_CHAR\(created_at/.test(sql)) {
      return { rows: [{ dia: "15/07/2026", total: 3 }] };
    }
    if (/EXTRACT\(HOUR FROM created_at/.test(sql)) {
      return { rows: [{ hora: 9, total: 2 }, { hora: 14, total: 7 }] };
    }
    if (/FROM users u/.test(sql) && /LEFT JOIN tickets t/.test(sql)) {
      return {
        rows: [
          { id: "u-1", nome: "Bruno", total_atendidos: 12, em_atendimento: 1 },
          { id: "u-2", nome: "Ana",   total_atendidos: 3,  em_atendimento: 0 },
        ]
      };
    }
    if (/AVG\(satisfaction_rating\)/.test(sql) && /GROUP BY assigned_to_name/.test(sql)) {
      return { rows: [{ nome: "Bruno", media: "4.50", total: 2 }] };
    }
    if (/AVG\(satisfaction_rating\)/.test(sql)) {
      return { rows: [{ media: "4.20", total: 5 }] };
    }
    // Feedback livre de nota baixa (migration 018) — ver "O que os clientes
    // disseram" na aba Métricas.
    if (/satisfaction_feedback/.test(sql)) {
      return {
        rows: [{
          protocolo: "2026-0099",
          customerName: "Cliente Insatisfeito",
          rating: 1,
          feedback: "Demorou muito pra responder",
          feedbackAt: "2026-07-21T12:00:00.000Z"
        }]
      };
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

  // Pedido do usuário (2026-07-21): feedback livre de "o que podemos
  // melhorar?" (nota baixa) precisa aparecer na resposta pro painel poder
  // listar — ver migration 018 e ticket.service.js.
  test("resposta inclui feedbacksNegativos (nota baixa + texto livre)", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(res.body.feedbacksNegativos).toEqual([{
      protocolo: "2026-0099",
      customerName: "Cliente Insatisfeito",
      rating: 1,
      feedback: "Demorou muito pra responder",
      feedbackAt: "2026-07-21T12:00:00.000Z"
    }]);
  });

  // PEDIDO DO USUÁRIO (2026-07-27): "quem está em atendimento/quem não" e
  // "quem atendeu mais" — a supervisora precisa ver, por atendente, o total
  // já atendido (histórico) e se tem ticket em_andamento agora. Status
  // online/offline em si é resolvido no frontend (window.onlineUsers via
  // socket), não faz parte desta resposta.
  test("resposta inclui atendentes (total atendido + em atendimento agora), ordenado por total_atendidos", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(res.body.atendentes).toEqual([
      { id: "u-1", nome: "Bruno", totalAtendidos: 12, emAtendimento: true },
      { id: "u-2", nome: "Ana",   totalAtendidos: 3,  emAtendimento: false },
    ]);
  });

  // PEDIDO DO USUÁRIO (2026-07-27): "horário de pico" pra decidir escala —
  // porHora sempre com as 24 horas (mesmo as sem nenhum atendimento, pra não
  // furar o eixo do gráfico) e horarioPico apontando a hora de maior volume.
  test("resposta inclui porHora (24h completas) e horarioPico", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.porHora)).toHaveLength(24);
    expect(res.body.porHora[9]).toBe(2);
    expect(res.body.porHora[14]).toBe(7);
    expect(res.body.porHora[0]).toBe(0); // hora sem nenhum atendimento no mock
    expect(res.body.horarioPico).toEqual({ hora: 14, total: 7 });
  });

  // PEDIDO DO USUÁRIO (2026-07-27): remover "setor destaque"/"por status"/
  // "por setor" da aba Métricas — não fazem mais parte da resposta.
  test("resposta NÃO inclui mais setorMaisMovimentado/porStatus/porSetor (removidos a pedido do usuário)", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(res.body.setorMaisMovimentado).toBeUndefined();
    expect(res.body.porStatus).toBeUndefined();
    expect(res.body.porSetor).toBeUndefined();
  });
});
