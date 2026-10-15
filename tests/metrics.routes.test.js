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
 *    "porStatus"/"setorMaisMovimentado" foram removidos a pedido do usuário
 *    nessa época; "porSetor" foi reintroduzido depois (2026-07-31, "atendimentos
 *    por setor" no painel de Métricas), então volta a fazer parte da resposta.
 *
 * Nota (2026-08-17, Issue #7): metrics.service.js cresceu bastante desde a
 * escrita original deste arquivo (tendência mês a mês, distribuição de
 * notas, atendimentos por setor, novos contatos/leads — todos pedidos do
 * usuário em 2026-07-31/2026-08-05). O mock de pool.query precisa cobrir as
 * 11 queries que buscarMetricas() dispara em paralelo (Promise.all) — faltar
 * uma faz a Promise.all inteira rejeitar (a query não mapeada joga um Error)
 * e todo teste desta suíte cai com 500, mesmo os que não olham pro campo
 * novo. Foi exatamente isso que aconteceu quando o CI passou a rodar contra
 * Postgres de verdade e esta suíte não tinha sido atualizada junto com o
 * service.
 *
 * Nota (2026-09-16, pedido do usuário "exportar métricas do mês anterior"):
 * buscarMetricas() ganhou uma query PRELIMINAR (_resolverLimites, roda ANTES
 * do Promise.all das 11) que resolve os limites de data (mês/mês anterior/
 * janela dos gráficos) — precisa de mock próprio (identificado por "AS
 * mes_inicio") ou a suíte inteira quebra igual ao caso acima, antes mesmo de
 * chegar nas outras 11.
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

    // Query preliminar de _resolverLimites (2026-09-16) — roda ANTES das 11
    // abaixo. Os valores em si não importam pro resto do mock (as outras
    // queries mockadas ignoram os parâmetros, só olham o texto do SQL), só
    // precisam existir pra não quebrar a desestruturação em buscarMetricas().
    if (/AS mes_inicio/.test(sql)) {
      return {
        rows: [{
          mes_inicio: new Date("2026-07-01T00:00:00Z"),
          mes_fim: new Date("2026-08-01T00:00:00Z"),
          mes_anterior_inicio: new Date("2026-06-01T00:00:00Z"),
          janela_inicio: new Date("2026-06-15T00:00:00Z"),
          janela_fim: new Date("2026-07-15T00:00:00Z")
        }]
      };
    }

    // Varredura 2026-10-15: fila atual virou query própria (pendentes/em
    // atendimento agora não têm versão "do mês").
    if (/AS pendentes_agora/.test(sql)) {
      return { rows: [{ pendentes_agora: 2, em_atendimento_agora: 3, tickets_no_banco: 10 }] };
    }
    // Varredura 2026-10-15: mediana + cobertura de TMA/TME.
    if (/AS tma_mediana_min/.test(sql)) {
      return {
        rows: [{
          tma_mediana_min: "30.0", tma_mediana_anterior_min: "40.0",
          tma_amostra: 8, tma_com_fechamento: 6,
          tme_mediana_min: "4.0", tme_mediana_anterior_min: "5.0",
          tme_amostra: 7, tickets_no_mes: 10,
          sla_resposta_dentro: 6, sla_resolucao_dentro: 5
        }]
      };
    }
    if (/COUNT\(\*\)::int\s+AS total/.test(sql) && /AS hoje/.test(sql)) {
      return {
        rows: [{
          total: 10, abertos: 2, andamento: 3, resolvidos: 4, cancelados: 1,
          hoje: 1, mensal: 10
        }]
      };
    }
    // Varredura 2026-10-15: o "por dia" passou a usar generate_series pra
    // preencher os dias sem atendimento.
    if (/generate_series/.test(sql) && /FROM tickets/.test(sql)) {
      return { rows: [{ dia: "15/07/2026", total: 3 }, { dia: "16/07/2026", total: 0 }] };
    }
    if (/EXTRACT\(HOUR FROM created_at/.test(sql)) {
      return { rows: [{ hora: 9, total: 2 }, { hora: 14, total: 7 }] };
    }
    // Varredura 2026-10-15: a contagem por atendente passou a sair dos
    // TICKETS (WITH agg), não mais de users LEFT JOIN tickets.
    if (/WITH agg AS/.test(sql)) {
      return {
        rows: [
          {
            id: "u-1", nome: "Bruno", sem_atendente: false, fora_do_cadastro: false, ativo: true,
            total_atendidos: 12, em_atendimento: 1, atendidos_hoje: 2, atendidos_semana: 5, atendidos_mes: 12
          },
          {
            id: "u-2", nome: "Ana", sem_atendente: false, fora_do_cadastro: false, ativo: true,
            total_atendidos: 3, em_atendimento: 0, atendidos_hoje: 0, atendidos_semana: 1, atendidos_mes: 3
          },
        ]
      };
    }
    if (/AVG\(t.satisfaction_rating\)/.test(sql) && /GROUP BY t.assigned_to/.test(sql)) {
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
    // Tendência mês atual x mês anterior (pedido do usuário, 2026-07-31) —
    // identificado pelo alias único mes_atual_total (não colide com o
    // summary acima, que não tem "AS hoje" junto de "mes_atual_total").
    if (/AS mes_atual_total/.test(sql)) {
      return {
        rows: [{
          mes_atual_total: 10, mes_atual_resolvidos: 7, mes_atual_cancelados: 1,
          mes_anterior_total: 8, mes_anterior_resolvidos: 5,
          tempo_resolucao_atual_min: "45.0", tempo_resolucao_anterior_min: "50.0",
          tempo_resposta_atual_min: "5.0", tempo_resposta_anterior_min: "6.0"
        }]
      };
    }
    // Distribuição de notas 1-5 (pedido do usuário, 2026-07-31).
    if (/AS nota/.test(sql) && /GROUP BY satisfaction_rating/.test(sql)) {
      return { rows: [{ nota: 5, total: 3 }, { nota: 1, total: 1 }] };
    }
    // Atendimentos por setor, últimos 30 dias (pedido do usuário, 2026-07-31).
    if (/GROUP BY sector/.test(sql)) {
      return { rows: [{ sector: "vendas", total: 6 }, { sector: null, total: 1 }] };
    }
    // Volume de mensagens (pedido do usuário, 2026-10-15).
    if (/FROM history/.test(sql) && /generate_series/.test(sql)) {
      return { rows: [{ dia: "15/07/2026", total: 12 }] };
    }
    if (/FROM history/.test(sql)) {
      return { rows: [{ total: 120, recebidas: 70, enviadas: 50, clientes: 9 }] };
    }
    // Atendimentos por mês (gráfico de 6 meses do PDF, 2026-09-17). Antes
    // da varredura 2026-10-15 esta query caía no mesmo matcher do "por dia"
    // (/TO_CHAR\(created_at/); agora que o "por dia" usa generate_series,
    // ela precisa do próprio.
    if (/'YYYY-MM'/.test(sql)) {
      return { rows: [{ mes: "2026-07", total: 10 }] };
    }
    // Novos contatos/leads (pedido do usuário, 2026-08-05; varredura
    // 2026-10-15 separou "novos no mês" do acumulado de leads).
    if (/FROM contacts/.test(sql)) {
      return { rows: [{ leads_acumulado: 4, novos_no_mes: 2 }] };
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
  //
  // BUG CORRIGIDO (2026-08-05, ver metrics.service.js): emAtendimento
  // virava um booleano antes de chegar aqui, jogando fora a contagem real
  // que a query já trazia (COUNT ... FILTER). Hoje é o número de tickets
  // em_andamento mesmo — este teste esperava o formato antigo (true/false).
  test("resposta inclui atendentes (total atendido + em atendimento agora), ordenado por total_atendidos", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    // Varredura 2026-10-15: cada linha ganhou semAtendente/foraDoCadastro/
    // ativo — a tabela agora sai dos tickets e precisa diferenciar "quem
    // atendeu mas não está mais no cadastro" de "ticket sem atendente".
    expect(res.body.atendentes).toEqual([
      {
        id: "u-1", nome: "Bruno", totalAtendidos: 12, emAtendimento: 1,
        atendidosHoje: 2, atendidosSemana: 5, atendidosMes: 12,
        semAtendente: false, foraDoCadastro: false, ativo: true
      },
      {
        id: "u-2", nome: "Ana", totalAtendidos: 3, emAtendimento: 0,
        atendidosHoje: 0, atendidosSemana: 1, atendidosMes: 3,
        semAtendente: false, foraDoCadastro: false, ativo: true
      },
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

  // PEDIDO DO USUÁRIO (2026-07-27): "setor destaque"/"por status" removidos
  // da aba Métricas nessa época — continuam fora da resposta. "porSetor" foi
  // reintroduzido depois (2026-07-31, "atendimentos por setor"), então HOJE
  // faz parte da resposta — teste e nome atualizados (Issue #7, 2026-08-17).
  test("resposta NÃO inclui mais setorMaisMovimentado/porStatus, mas porSetor voltou a existir (2026-07-31)", async () => {
    const res = await request(buildApp(SUPERVISOR)).get("/api/metrics");

    expect(res.status).toBe(200);
    expect(res.body.setorMaisMovimentado).toBeUndefined();
    expect(res.body.porStatus).toBeUndefined();
    expect(res.body.porSetor).toEqual({ geral: 1, vendas: 6 });
  });
});
