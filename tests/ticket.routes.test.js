/**
 * Testes de ticket.routes.js — validação de entrada, autorização
 * (canAccessTicket/canManageTicket/canSeeSensitiveDashboard — a lógica em si
 * já é coberta por tests/access-control.test.js, aqui só confirmamos que as
 * rotas realmente aplicam essas checagens) e os efeitos colaterais de
 * humanMode (pausar/reativar o bot ao assumir/fechar ticket).
 *
 * pool.query é mockado com uma tabela "tickets" em memória — as regras de
 * SQL (WHERE dinâmico, idOrProtocolWhere etc.) já são testadas diretamente
 * em tests/ticket.repository.test.js; aqui o foco é o comportamento HTTP.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/humanMode.service", () => ({
  ativar: jest.fn(),
  desativar: jest.fn(),
  estaAtivo: jest.fn().mockReturnValue(false),
  listar: jest.fn().mockReturnValue([]),
  carregar: jest.fn().mockResolvedValue(undefined),
  renovar: jest.fn()
}));
jest.mock("../src/repositories/user.repository", () => ({
  findById: jest.fn()
}));
jest.mock("../src/config/whatsapp", () => ({
  sendMessage: jest.fn().mockResolvedValue({ id: "wamid-saudacao" })
}));
jest.mock("../src/services/history.service", () => ({
  saveHistory: jest.fn().mockResolvedValue({ id: "hist-saudacao", createdAt: new Date() })
}));
// Pedido do usuário (2026-07-24): createTicket agora chama marcarComoCliente
// (contacts.service.js). Mockado pra não depender de banco real e não
// poluir os logs com o warning de erro que apareceria sem esse mock.
jest.mock("../src/services/contacts.service", () => ({
  marcarComoCliente: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    atendimento: {
      mensagemSaudacaoAtendente: "Olá! Me chamo {nome} e vou continuar seu atendimento a partir de agora.",
      mensagemPesquisaSatisfacao: "De 1 a 5, o quanto você ficou satisfeito com nosso atendimento? Responda só com o número.",
      mensagemAgradecimentoPesquisa: "Muito obrigado pela sua avaliação!"
    }
  })
}));

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const humanMode = require("../src/services/humanMode.service");
const userRepository = require("../src/repositories/user.repository");
const whatsapp = require("../src/config/whatsapp");
const historyService = require("../src/services/history.service");
const settingsService = require("../src/services/settings.service");
const ticketRoutes = require("../src/routes/ticket.routes");
const ticketService = require("../src/services/ticket.service");

// tickets.id é SERIAL (inteiro), não uuid — ver schema.sql. Um bug real já
// aconteceu aqui: fixtures antigas usavam um id em formato UUID, o que
// mascarava uma regressão em idOrProtocolWhere() que só reconhecia UUID e
// por isso nunca batia com o id real de um ticket. Por isso o fake id
// aqui é deliberadamente um inteiro sequencial, como na tabela real.
let idCounter = 0;
function fakeId() {
  idCounter += 1;
  return idCounter;
}

function buildState() {
  return { tickets: [] };
}

function findTicket(state, value) {
  // t.id é number (como o driver do pg devolve uma coluna integer); value
  // vem sempre como string (é o que idOrProtocolWhere/req.params.id usam)
  // — por isso a comparação de id precisa coagir com String(), senão
  // "42" !== 42 mascararia silenciosamente o mesmo tipo de bug já visto
  // em produção (id nunca bate).
  return state.tickets.find(t => String(t.id) === value || t.protocolo === value);
}

function installFakePool(state) {
  pool.query.mockImplementation(async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/^SELECT nextval/.test(sql)) {
      return { rows: [{ numero: state.tickets.length + 1 }] };
    }

    if (/^INSERT INTO tickets/.test(sql)) {
      const row = {
        id: fakeId(),
        protocolo: params[0],
        user_id: params[1],
        customer_name: params[2],
        cpf: params[3],
        type: params[4],
        sector: params[5],
        description: params[6],
        status: params[7],
        assigned_to: params[8],
        assigned_to_name: params[9],
        created_at: params[10],
        updated_at: params[11]
      };
      state.tickets.push(row);
      return { rows: [row] };
    }

    if (/^SELECT \* FROM tickets WHERE \(id = \$1::int OR protocolo = \$1(::text)?\) LIMIT 1/.test(sql)
      || /^SELECT \* FROM tickets WHERE protocolo = \$1 LIMIT 1/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [t] : [] };
    }

    if (/^SELECT id, assigned_to, assigned_to_name FROM tickets WHERE/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [{ id: t.id, assigned_to: t.assigned_to, assigned_to_name: t.assigned_to_name }] : [] };
    }

    // Re-consulta usada só na corrida de assign() (UPDATE não afeta linha) para
    // descobrir quem venceu a corrida.
    if (/^SELECT assigned_to_name FROM tickets WHERE/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [{ assigned_to_name: t.assigned_to_name }] : [] };
    }

    if (/^UPDATE tickets\s+SET status = \$1/.test(sql)) {
      const t = findTicket(state, params[1]);
      if (!t) return { rows: [] };
      t.status = params[0];
      // Espelha o comportamento real: reabrir (status "aberto") limpa a
      // atribuição anterior — ver BUG CORRIGIDO em ticket.repository.js.
      if (/assigned_to = NULL/.test(sql)) {
        t.assigned_to = null;
        t.assigned_to_name = null;
      }
      // Migration 026: fechar grava closed_at, reabrir limpa — espelha
      // updateStatus() (ticket.repository.js).
      if (/closed_at = NOW\(\)/.test(sql)) {
        t.closed_at = new Date().toISOString();
      }
      if (/closed_at = NULL/.test(sql)) {
        t.closed_at = null;
      }
      // Pedido do usuário (2026-07-24): reabertura manual (default,
      // resetSatisfaction:true) zera os campos de satisfação; reabertura
      // AUTOMÁTICA (reopenTicketIfClosed, resetSatisfaction:false) não
      // inclui essa cláusula no SQL — espelha isso aqui pra poder testar
      // a diferença de verdade (ver "reabertura automática... pula
      // saudação" abaixo).
      if (/satisfaction_asked_at = NULL/.test(sql)) {
        t.satisfaction_asked_at = null;
        t.satisfaction_rating = null;
        t.satisfaction_rated_at = null;
      }
      return { rows: [t] };
    }

    // Pesquisa de satisfação: askSatisfaction() marca satisfaction_asked_at
    // — espelha a reivindicação atômica real ("AND satisfaction_asked_at IS
    // NULL"): só "clama" (afeta linha) se ainda não tiver sido pedida.
    if (/^UPDATE tickets\s+SET satisfaction_asked_at = NOW\(\)/.test(sql)) {
      const t = findTicket(state, params[0]);
      if (!t || t.satisfaction_asked_at) return { rows: [] };
      t.satisfaction_asked_at = new Date().toISOString();
      return { rows: [t] };
    }

    // BUG DE FIXTURE ACHADO (2026-08-14): hasSurveyAskedToday()
    // (ticket.repository.js, feature "só 1 pesquisa por cliente ao dia" de
    // 30/07) nunca tinha um handler aqui — caía em "Query não mapeada",
    // engolida pelo catch best-effort de enviarPesquisaSatisfacao, fazendo
    // vários testes de pesquisa de satisfação falharem silenciosamente sem
    // relação nenhuma com o que estava sendo testado.
    if (/^SELECT 1 FROM tickets\s+WHERE user_id = \$1\s+AND satisfaction_asked_at IS NOT NULL/.test(sql)) {
      const t = state.tickets.find(x => x.user_id === params[0] && x.satisfaction_asked_at);
      return { rows: t ? [{ "?column?": 1 }] : [] };
    }

    if (/^UPDATE tickets\s+SET assigned_to = \$1/.test(sql)) {
      const t = findTicket(state, params[2]);
      if (!t || t.assigned_to) return { rows: [] };
      t.assigned_to = params[0];
      t.assigned_to_name = params[1];
      t.status = "em_andamento";
      return { rows: [t] };
    }

    if (/^UPDATE tickets\s+SET sector\s+=/.test(sql)) {
      const t = findTicket(state, params[4]);
      if (!t) return { rows: [] };
      t.sector = params[0];
      t.assigned_to = params[1];
      t.assigned_to_name = params[2];
      t.status = params[3];
      return { rows: [t] };
    }

    if (/^SELECT \* FROM tickets WHERE user_id = ANY/.test(sql)) {
      const ids = new Set(params[0] || []);
      return { rows: state.tickets.filter(t => ids.has(t.user_id)) };
    }

    if (/^SELECT \* FROM tickets\s*(WHERE|ORDER)/.test(sql) || sql.startsWith("SELECT * FROM tickets")) {
      return { rows: [...state.tickets] };
    }

    if (/COUNT\(\*\)::int AS total/.test(sql) && /FILTER \(WHERE status = 'aberto'\)/.test(sql)) {
      const total = state.tickets.length;
      const count = st => state.tickets.filter(t => t.status === st).length;
      return {
        rows: [{
          total,
          aberto: count("aberto"),
          em_andamento: count("em_andamento"),
          resolvido: count("resolvido"),
          cancelado: count("cancelado")
        }]
      };
    }

    if (/COALESCE\(sector,'geral'\) AS setor/.test(sql)) {
      return { rows: [] };
    }

    if (/assigned_to_name AS nome/.test(sql)) {
      return { rows: [] };
    }

    if (/WHERE DATE\(created_at AT TIME ZONE \$1\) = CURRENT_DATE/.test(sql)) {
      return { rows: [{ total: 0 }] };
    }

    // Migration 026: "Encerrados hoje" — countEncerradosNoPeriodo()
    // (ticket.repository.js), conta por closed_at em vez de created_at.
    if (/^SELECT COUNT\(\*\)::int AS encerrados/.test(sql)) {
      const encerrados = state.tickets.filter(t => t.closed_at).length;
      return { rows: [{ encerrados }] };
    }

    throw new Error("Query não mapeada no mock de ticket.routes.test.js: " + sql);
  });
}

function buildApp(currentUser) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = currentUser;
    next();
  });
  app.use("/api", ticketRoutes);
  return app;
}

const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };
const ATENDENTE_VENDAS = { id: "at-vendas", nome: "Bruno", perfil: "atendente", sector: "vendas" };

const FULL_ACCESS_ENV_KEY = "ATTENDANT_CONVERSATIONS_FULL_ACCESS";
const ORIGINAL_FULL_ACCESS_ENV = process.env[FULL_ACCESS_ENV_KEY];

describe("ticket.routes", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
  });

  afterEach(() => {
    if (ORIGINAL_FULL_ACCESS_ENV === undefined) delete process.env[FULL_ACCESS_ENV_KEY];
    else process.env[FULL_ACCESS_ENV_KEY] = ORIGINAL_FULL_ACCESS_ENV;
  });

  describe("POST /tickets", () => {
    test("userId ausente → 400", async () => {
      const app = buildApp(ADMIN);
      const res = await request(app).post("/api/tickets").send({ type: "orcamento" });
      expect(res.status).toBe(400);
    });

    test("type ausente → 400", async () => {
      const app = buildApp(ADMIN);
      const res = await request(app).post("/api/tickets").send({ userId: "55999@s.whatsapp.net" });
      expect(res.status).toBe(400);
    });

    test("cria ticket e mapeia type → sector automaticamente (orcamento → vendas)", async () => {
      const app = buildApp(ADMIN);
      const res = await request(app)
        .post("/api/tickets")
        .send({ userId: "55999@s.whatsapp.net", type: "orcamento", customerName: "Cliente X" });

      expect(res.status).toBe(201);
      expect(res.body.ticket).toMatchObject({ sector: "vendas", status: "aberto" });
      expect(res.body.ticket.protocolo).toEqual(expect.any(String));
    });
  });

  describe("GET /tickets", () => {
    test("status inválido no filtro → 400", async () => {
      const app = buildApp(ADMIN);
      const res = await request(app).get("/api/tickets?status=inexistente");
      expect(res.status).toBe(400);
    });

    test("admin lista todos os tickets, com stats agregadas", async () => {
      await request(buildApp(ADMIN)).post("/api/tickets").send({ userId: "u1", type: "orcamento" });
      await request(buildApp(ADMIN)).post("/api/tickets").send({ userId: "u2", type: "suporte_tecnico" });

      const res = await request(buildApp(ADMIN)).get("/api/tickets");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.stats.total).toBe(2);
    });

    // BUG CORRIGIDO (#96): o painel cruza GET /api/tickets com
    // GET /api/history/conversations por userId (ticketsByUser[userId] em
    // frontend/js/07-conversations.js) — se o ticket estiver salvo sob
    // "...@lid" mas a conversa já aparecer resolvida para
    // "...@s.whatsapp.net" (ou vice-versa), o cruzamento falha e o cliente
    // aparece como se não tivesse ticket algum. GET /api/tickets agora
    // devolve o userId já canonicalizado (jid, quando o mapeamento lid→jid
    // é conhecido) pra concordar com o que getConversationsHandler também
    // canonicaliza.
    test("ticket salvo com userId em formato @lid volta na lista já com o jid resolvido", async () => {
      const { setLidMapping } = require("../src/whatsapp/lid-map");
      const lid = "700800900100200@lid";
      const jid = "5511955556666@s.whatsapp.net";
      setLidMapping(lid, jid, "test");

      const created = await request(buildApp(ADMIN)).post("/api/tickets").send({ userId: lid, type: "orcamento" });
      const id = created.body.ticket.id;

      const res = await request(buildApp(ADMIN)).get("/api/tickets");
      const ticket = res.body.tickets.find(t => t.id === id);

      expect(ticket.userId).toBe(jid);
    });

    // Pedido do usuário: a UI da conversa precisa saber se o atendente
    // logado pode gerenciar QUALQUER ticket (full access/privilegiado) ou
    // só o que é dele, pra travar os botões de ação antes de clicar em vez
    // de deixar clicar e só então mostrar 403.
    test("canManageAnyTicket reflete full access (true pra admin, false pro atendente em modo restrito)", async () => {
      const resAdmin = await request(buildApp(ADMIN)).get("/api/tickets");
      expect(resAdmin.body.canManageAnyTicket).toBe(true);

      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const resAtendente = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets");
      expect(resAtendente.body.canManageAnyTicket).toBe(false);
    });

    // BUG CORRIGIDO: em modo restrito, um ticket assumido por OUTRO
    // atendente sumia por completo da resposta — o frontend não tinha
    // como distinguir isso de "cliente novo, sem ticket ainda" e mostrava
    // esse cliente incorretamente na aba "Pendentes". hiddenActiveUserIds
    // avisa o frontend de quem tem ticket ativo escondido, pra ocultar
    // a conversa por completo em vez de reclassificá-la como pendente.
    describe("modo restrito (ATTENDANT_CONVERSATIONS_FULL_ACCESS=false)", () => {
      beforeEach(() => { process.env[FULL_ACCESS_ENV_KEY] = "false"; });

      test("ticket assumido por outro atendente do mesmo setor some da lista, mas aparece em hiddenActiveUserIds", async () => {
        const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "vendas" };

        const created = await request(buildApp(ADMIN)).post("/api/tickets")
          .send({ userId: "cliente-x", type: "orcamento" }); // sector: vendas
        const id = created.body.ticket.id;

        await request(buildApp(outroAtendente)).patch(`/api/tickets/${id}/assign`);

        const res = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets");

        expect(res.status).toBe(200);
        expect(res.body.tickets.find(t => t.id === id)).toBeUndefined();
        expect(res.body.hiddenActiveUserIds).toContain("cliente-x");
      });

      test("ticket ainda não assumido no mesmo setor continua visível (não entra em hiddenActiveUserIds)", async () => {
        const created = await request(buildApp(ADMIN)).post("/api/tickets")
          .send({ userId: "cliente-y", type: "orcamento" });
        const id = created.body.ticket.id;

        const res = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets");

        expect(res.body.tickets.find(t => t.id === id)).toBeTruthy();
        expect(res.body.hiddenActiveUserIds).not.toContain("cliente-y");
      });

      // Pedido do usuário: "Fechados" deve aparecer igual pra todo mundo,
      // mesmo em modo restrito — sem disputa de "de quem é" depois de
      // fechado, diferente de tickets ainda ativos (aberto/em_andamento).
      test("ticket FECHADO por outro atendente de OUTRO setor continua visível pra todos (não some, não entra em hiddenActiveUserIds)", async () => {
        const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "financeiro" };

        const created = await request(buildApp(ADMIN)).post("/api/tickets")
          .send({ userId: "cliente-z", type: "duvida_financeira" }); // sector: financeiro
        const id = created.body.ticket.id;

        await request(buildApp(outroAtendente)).patch(`/api/tickets/${id}/assign`);
        await request(buildApp(outroAtendente)).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

        // ATENDENTE_VENDAS é de outro setor e nunca foi atribuído a esse ticket
        const res = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets");

        expect(res.body.tickets.find(t => t.id === id)).toBeTruthy();
        expect(res.body.hiddenActiveUserIds).not.toContain("cliente-z");
      });

      // Pedido do usuário: "Pendentes" deve aparecer IDÊNTICO pra todos os
      // atendentes, igual Fechados — mesmo entre setores diferentes.
      // ticket.controller.js agora trata status "aberto" igual a
      // resolvido/cancelado: bypassa o filtro de setor/atribuição.
      test("ticket PENDENTE (aberto, nunca assumido) de OUTRO setor também aparece — visível pra todos", async () => {
        const atendenteFinanceiro = { id: "at-fin", nome: "Carla", perfil: "atendente", sector: "financeiro" };

        const created = await request(buildApp(ADMIN)).post("/api/tickets")
          .send({ userId: "cliente-v", type: "orcamento" }); // sector: vendas
        const id = created.body.ticket.id;

        // ATENDENTE_VENDAS (mesmo setor) já era esperado ver — confirma que
        // continua vendo.
        const resVendas = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets");
        expect(resVendas.body.tickets.find(t => t.id === id)).toBeTruthy();

        // atendenteFinanceiro é de OUTRO setor e nunca assumiu — antes ficava
        // oculto; agora deve ver igual, pendente é pendente pra todo mundo.
        const resFinanceiro = await request(buildApp(atendenteFinanceiro)).get("/api/tickets");
        expect(resFinanceiro.body.tickets.find(t => t.id === id)).toBeTruthy();
        expect(resFinanceiro.body.hiddenActiveUserIds).not.toContain("cliente-v");
      });

      // Pedido do usuário: garantir que isso vale também pra um ticket
      // REABERTO (reopenTicketIfClosed) — cliente manda mensagem de novo
      // após o atendimento ter sido fechado por outro atendente de outro
      // setor. Antes o reaberto só aparecia pendente pro setor do ticket;
      // agora aparece igual pra qualquer atendente, admin, etc.
      test("ticket REABERTO (reopenTicketIfClosed) aparece como pendente pra TODOS, independente de setor", async () => {
        const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "vendas" };
        const atendenteFinanceiro = { id: "at-fin", nome: "Carla", perfil: "atendente", sector: "financeiro" };

        const created = await request(buildApp(ADMIN)).post("/api/tickets")
          .send({ userId: "cliente-w", type: "orcamento" }); // sector: vendas
        const id = created.body.ticket.id;

        await request(buildApp(outroAtendente)).patch(`/api/tickets/${id}/assign`);
        await request(buildApp(outroAtendente)).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

        // Cliente manda mensagem de novo → bot chama reopenTicketIfClosed
        // (mesmo caminho usado em produção, não um UPDATE direto no mock)
        const reabriu = await ticketService.reopenTicketIfClosed("cliente-w");
        expect(reabriu).toBe(true);

        // Atendente do MESMO setor (vendas) do ticket → vê como pendente
        const resVendas = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets");
        const ticketVendas = resVendas.body.tickets.find(t => t.id === id);
        expect(ticketVendas).toBeTruthy();
        expect(ticketVendas.status).toBe("aberto");
        expect(ticketVendas.assignedTo).toBeFalsy();
        expect(resVendas.body.hiddenActiveUserIds).not.toContain("cliente-w");

        // Atendente de OUTRO setor (financeiro) → agora TAMBÉM vê, igual
        // qualquer outro atendente (pedido explícito do usuário).
        const resFinanceiro = await request(buildApp(atendenteFinanceiro)).get("/api/tickets");
        const ticketFinanceiro = resFinanceiro.body.tickets.find(t => t.id === id);
        expect(ticketFinanceiro).toBeTruthy();
        expect(ticketFinanceiro.status).toBe("aberto");
        expect(resFinanceiro.body.hiddenActiveUserIds).not.toContain("cliente-w");

        // Admin (full access) sempre vê tudo, independente de setor
        const resAdmin = await request(buildApp(ADMIN)).get("/api/tickets");
        expect(resAdmin.body.tickets.find(t => t.id === id)).toBeTruthy();
      });
    });
  });

  describe("PATCH /tickets/:id (status)", () => {
    async function criarTicket(user, overrides = {}) {
      const res = await request(buildApp(user))
        .post("/api/tickets")
        .send({ userId: "u1", type: "orcamento", ...overrides });
      return res.body.ticket;
    }

    test("status inválido → 400", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "não-existe" });
      expect(res.status).toBe(400);
    });

    test("ticket inexistente → 404", async () => {
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/nao-existe`)
        .send({ status: "resolvido" });
      expect(res.status).toBe(404);
    });

    // BUG CORRIGIDO: esta suíte esperava 403 pra um atendente do MESMO setor
    // fechando um ticket ainda não assumido — mas isso é exatamente o caso
    // de "Fechar em Pendentes" relatado pelo usuário como quebrado ("sem
    // permissão"). canManageTicket agora permite ticket livre + mesmo setor
    // (igual já valia pra canAccessTicket/"Assumir" — ver access-control.test.js).
    //
    // ATUALIZADO (pedido do usuário): pendente/fechado agora é gerenciável
    // por QUALQUER atendente, não só do mesmo setor — mesma regra da
    // visibilidade (Pendentes/Fechados iguais pra todos). Reportado pelo
    // usuário: "não estou conseguindo reabrir nem fechar com usuarios
    // atendentes" — atendente de outro setor levava 403 ao tentar fechar um
    // pendente visível mas de setor diferente.
    test("atendente de OUTRO setor TAMBÉM gerencia ticket pendente (aberto) ainda não assumido", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const atendenteFinanceiro = { id: "at-fin", nome: "Carla", perfil: "atendente", sector: "financeiro" };

      const ticket = await criarTicket(ADMIN); // orcamento → sector vendas, ninguém assumiu
      const res = await request(buildApp(atendenteFinanceiro))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });
      expect(res.status).toBe(200);
    });

    // Reportado pelo usuário: atendente que NÃO foi quem fechou um ticket
    // (fechar não limpa assigned_to — só reabrir limpa) levava 403 ao
    // tentar Reabrir, mesmo sendo do mesmo setor. Fechado é história
    // compartilhada — qualquer atendente pode reabrir.
    test("atendente que NÃO foi quem fechou consegue reabrir o ticket (mesmo setor)", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "vendas" };

      const ticket = await criarTicket(ADMIN);
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}/assign`);
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });

      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "aberto" });
      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe("aberto");
    });

    // Mesmo caso, mas o atendente que reabre é de OUTRO setor — também deve
    // funcionar, ticket fechado não tem dono em disputa.
    test("atendente de OUTRO setor também consegue reabrir um ticket fechado", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "vendas" };
      const atendenteFinanceiro = { id: "at-fin", nome: "Carla", perfil: "atendente", sector: "financeiro" };

      const ticket = await criarTicket(ADMIN); // sector: vendas
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}/assign`);
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });

      const res = await request(buildApp(atendenteFinanceiro))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "aberto" });
      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe("aberto");
    });

    test("atendente do MESMO setor gerencia ticket ainda não assumido (modo restrito)", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";

      const ticket = await criarTicket(ADMIN); // orcamento → sector vendas, ninguém assumiu
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });
      expect(res.status).toBe(200);
    });

    test("atendente não gerencia ticket já assumido por OUTRO atendente do mesmo setor → 403", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "vendas" };

      const created = await criarTicket(ADMIN);
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${created.id}/assign`);

      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${created.id}`)
        .send({ status: "resolvido" });
      expect(res.status).toBe(403);
    });

    test("fechar ticket (resolvido) chama humanMode.desativar", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });

      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe("resolvido");
      expect(humanMode.desativar).toHaveBeenCalledWith("u1", "ticket_fechado");
    });

    test("BUG CORRIGIDO: reabrir ticket fechado libera a atribuição — assumir de novo funciona, não diz 'já assumido'", async () => {
      // Reproduz exatamente o bug relatado pelo usuário: assume, fecha,
      // reabre, tenta assumir de novo — antes disso, a 3ª tentativa (assumir
      // depois de reaberto) sempre voltava 409 "já assumido por Bruno",
      // porque reabrir só trocava o status e nunca limpava assigned_to.
      const ticket = await criarTicket(ADMIN);

      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}/assign`).send({});
      await request(buildApp(ADMIN)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });
      const reabrir = await request(buildApp(ADMIN)).patch(`/api/tickets/${ticket.id}`).send({ status: "aberto" });

      expect(reabrir.status).toBe(200);
      expect(reabrir.body.ticket.assignedTo).toBeNull();

      const outroAtendente = { id: "at-2", nome: "Carla", perfil: "atendente", sector: "vendas" };
      const assumirDeNovo = await request(buildApp(outroAtendente))
        .patch(`/api/tickets/${ticket.id}/assign`)
        .send({});

      expect(assumirDeNovo.status).toBe(200);
      expect(assumirDeNovo.body.ticket.assignedTo).toBe("at-2");
    });

    // BUG CORRIGIDO (relatado pelo usuário): "se o cliente estiver ativo com
    // outro usuário, ainda aparece a possibilidade de reabrir em Fechados —
    // se clicar, rouba o cliente do outro atendente". Cenário: cliente tem
    // um ticket ANTIGO já resolvido (que aparece em Fechados) e um ticket
    // NOVO em_andamento (assumido por outro atendente) — reabrir o antigo
    // não pode ser permitido enquanto o novo estiver ativo.
    test("BUG CORRIGIDO: reabrir bloqueado (409) quando cliente já tem outro ticket em_andamento", async () => {
      const ticketAntigo = await criarTicket(ADMIN);
      await request(buildApp(ADMIN)).patch(`/api/tickets/${ticketAntigo.id}`).send({ status: "resolvido" });

      // Cliente manda mensagem de novo → cria/assume um ticket NOVO, que
      // fica em_andamento (assumido por outro atendente).
      const ticketNovo = await criarTicket(ADMIN);
      const outroAtendente = { id: "at-2", nome: "Junior", perfil: "atendente", sector: "vendas" };
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticketNovo.id}/assign`);

      // Atendente B, com o painel desatualizado, ainda vê o ticket ANTIGO em
      // Fechados e tenta reabrir — deve ser bloqueado.
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticketAntigo.id}`)
        .send({ status: "aberto" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/atendimento ativo/);
      expect(res.body.assignedToName).toBe("Junior");

      // Confirma que o ticket antigo continua resolvido (não foi reaberto)
      // e o novo continua em_andamento — nenhum dos dois foi mexido.
      const antigoAtual = await request(buildApp(ADMIN)).get(`/api/tickets`);
      const antigoNoBanco = antigoAtual.body.tickets.find(t => t.id === ticketAntigo.id);
      expect(antigoNoBanco.status).toBe("resolvido");
    });

    // BUG CORRIGIDO (reportado pelo usuário DEPOIS do fix acima, o guard por
    // userId exato não era suficiente): o mesmo cliente real pode ter
    // tickets salvos com formatos DIFERENTES de identificador — o WhatsApp
    // entrega mensagens como "...@lid" (dispositivo vinculado) que às vezes
    // o Baileys resolve para "...@s.whatsapp.net" e às vezes não (ver
    // LID_FALLBACK em src/config/whatsapp.js). Um ticket antigo resolvido
    // salvo como "@lid" e o ticket novo em_andamento do MESMO cliente salvo
    // já resolvido como "@s.whatsapp.net" faziam o guard por userId exato
    // não encontrar o ticket ativo — reabrir continuava "roubando" o
    // cliente na prática. getProfilePhotoCandidates (lid-map.js) resolve
    // essa equivalência via o mapeamento lid↔jid já existente no projeto.
    test("BUG CORRIGIDO: reabrir bloqueado mesmo quando o ticket ativo está salvo com outro formato de userId (lid vs jid)", async () => {
      const { setLidMapping } = require("../src/whatsapp/lid-map");
      const lid = "111222333444555@lid";
      const jid = "5511988887777@s.whatsapp.net";
      setLidMapping(lid, jid, "test");

      const ticketAntigo = await criarTicket(ADMIN, { userId: lid });
      await request(buildApp(ADMIN)).patch(`/api/tickets/${ticketAntigo.id}`).send({ status: "resolvido" });

      // Mesmo cliente real, mas desta vez a mensagem chegou já resolvida
      // para o JID — ticket novo é salvo com o OUTRO formato de userId.
      const ticketNovo = await criarTicket(ADMIN, { userId: jid });
      const outroAtendente = { id: "at-3", nome: "Carla", perfil: "atendente", sector: "vendas" };
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticketNovo.id}/assign`);

      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticketAntigo.id}`)
        .send({ status: "aberto" });

      expect(res.status).toBe(409);
      expect(res.body.assignedToName).toBe("Carla");

      const atual = await request(buildApp(ADMIN)).get(`/api/tickets`);
      expect(atual.body.tickets.find(t => t.id === ticketAntigo.id).status).toBe("resolvido");
    });
  });

  // Pedido do usuário: pesquisa de satisfação automática ao fechar um
  // atendimento (status → resolvido). Cliente responde 1-5 depois — a
  // captura dessa resposta é testada em tests/ticket.service.satisfaction.test.js
  // e tests/message.service.test.js; aqui o foco é só o disparo do envio +
  // askSatisfaction() ao fechar, no mesmo padrão best-effort da saudação.
  describe("PATCH /tickets/:id — pesquisa de satisfação ao resolver", () => {
    // PEDIDO DO USUÁRIO (2026-08-14): fechar como perfil "admin" agora NUNCA
    // dispara a pesquisa, incondicionalmente (ver describe dedicado mais
    // abaixo) — usar ADMIN aqui esconderia a lógica de dedup/skipSurvey/
    // template-vazio sendo testada neste bloco atrás desse bloqueio. Fecha
    // com ATENDENTE_VENDAS em vez disso.
    async function criarTicket(user) {
      const res = await request(buildApp(user)).post("/api/tickets").send({ userId: "u1", type: "orcamento" });
      return res.body.ticket;
    }

    test("fechar como resolvido envia a pesquisa e marca satisfaction_asked_at", async () => {
      const ticket = await criarTicket(ATENDENTE_VENDAS);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });

      expect(res.status).toBe(200);
      expect(whatsapp.sendMessage).toHaveBeenCalledWith(
        "u1",
        expect.stringContaining("De 1 a 5")
      );
      expect(historyService.saveHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1", sector: "manual", response: expect.stringContaining("De 1 a 5") })
      );
    });

    test("cancelar (não resolvido) NÃO envia pesquisa de satisfação", async () => {
      const ticket = await criarTicket(ATENDENTE_VENDAS);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "cancelado" });

      expect(res.status).toBe(200);
      expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });

    test("template de pesquisa vazio (desativado nas configurações) → não envia mensagem nenhuma", async () => {
      settingsService.getSettings.mockResolvedValueOnce({
        atendimento: { mensagemSaudacaoAtendente: "", mensagemPesquisaSatisfacao: "" }
      });

      const ticket = await criarTicket(ATENDENTE_VENDAS);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });

      expect(res.status).toBe(200);
      expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });

    test("falha ao enviar a pesquisa não impede o fechamento do ticket (best-effort)", async () => {
      whatsapp.sendMessage.mockRejectedValueOnce(new Error("WhatsApp indisponível"));

      const ticket = await criarTicket(ATENDENTE_VENDAS);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });

      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe("resolvido");
    });

    // PEDIDO DO USUÁRIO (2026-07-27): varredura de tickets já concluídos mas
    // esquecidos em Pendentes — fechar em massa sem incomodar o cliente com
    // uma pesquisa fora de contexto, dias depois do atendimento real.
    test("fechar com skipSurvey:true → fecha normalmente mas NÃO envia a pesquisa", async () => {
      const ticket = await criarTicket(ATENDENTE_VENDAS);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido", skipSurvey: true });

      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe("resolvido");
      expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });

    test("skipSurvey ausente (comportamento padrão) → continua enviando a pesquisa normalmente", async () => {
      const ticket = await criarTicket(ATENDENTE_VENDAS);
      await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });

      expect(whatsapp.sendMessage).toHaveBeenCalledWith("u1", expect.stringContaining("De 1 a 5"));
    });

    // PEDIDO DO USUÁRIO (2026-08-14): "sempre que eu fechar algum
    // atendimento pelo usuário administrador, independentemente, não solte
    // pesquisa satisfatória" — bloqueio incondicional pelo perfil de quem
    // fecha, mesmo em condições que normalmente disparariam a pesquisa (1º
    // fechamento do dia, sem skipSurvey, template preenchido — ver testes
    // acima que passam nessas mesmas condições com ATENDENTE_VENDAS).
    test("fechar como admin NÃO envia a pesquisa, mesmo sem skipSurvey", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}`)
        .send({ status: "resolvido" });

      expect(res.status).toBe(200);
      expect(res.body.ticket.status).toBe("resolvido");
      expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });
  });

  // BUG CORRIGIDO (relatado pelo usuário, 2026-07-24): "cliente fecha,
  // recebe pesquisa, manda mensagem de novo (reabre — vira Pendente),
  // atendente assume (saudação repete), fecha de novo (pesquisa repete)".
  // Reproduz o ciclo completo: assume → fecha (pesquisa 1x) → reabertura
  // AUTOMÁTICA (reopenTicketIfClosed, mesmo caminho usado quando o cliente
  // manda mensagem depois do fechamento) → assume de novo (saudação NÃO
  // deve repetir) → fecha de novo (pesquisa NÃO deve repetir).
  describe("Reabertura automática (mesma conversa) não repete saudação nem pesquisa", () => {
    async function criarTicket(user, userId = "u1") {
      const res = await request(buildApp(user)).post("/api/tickets").send({ userId, type: "orcamento" });
      return res.body.ticket;
    }

    test("ciclo completo: assume → fecha (pesquisa) → reabre automático → assume de novo (sem saudação) → fecha de novo (sem pesquisa nova)", async () => {
      const userId = "u-ciclo-1";
      ticketService.clearReopenCooldown(userId);

      const ticket = await criarTicket(ADMIN, userId);

      // 1ª vez: assume → saudação enviada.
      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}/assign`).send({});
      expect(whatsapp.sendMessage).toHaveBeenCalledWith(
        userId,
        expect.stringContaining("Me chamo")
      );

      // Fecha → pesquisa enviada (1x). Fechado por um atendente comum, não
      // admin — desde 2026-08-14 fechar como "admin" nunca dispara a
      // pesquisa (ver describe dedicado), o que esconderia o dedup sendo
      // testado aqui.
      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });
      expect(whatsapp.sendMessage).toHaveBeenCalledWith(
        userId,
        expect.stringContaining("De 1 a 5")
      );
      whatsapp.sendMessage.mockClear();

      // Cliente manda mensagem de novo, pouco depois — reabertura
      // AUTOMÁTICA (mesmo caminho usado em produção via message.service.js).
      const reaberto = await ticketService.reopenTicketIfClosed(userId);
      expect(reaberto).toBe(true);

      // Assume de novo — NÃO deve reenviar a saudação (mesma conversa
      // continuando, não um atendimento novo).
      const outroAtendente = { id: "at-2", nome: "Carla", perfil: "atendente", sector: "vendas" };
      const assumirDeNovo = await request(buildApp(outroAtendente))
        .patch(`/api/tickets/${ticket.id}/assign`)
        .send({});
      expect(assumirDeNovo.status).toBe(200);
      expect(whatsapp.sendMessage).not.toHaveBeenCalledWith(
        userId,
        expect.stringContaining("Me chamo")
      );

      // Fecha de novo — NÃO deve reenviar a pesquisa (já foi enviada e
      // ainda não foi limpa, já que a reabertura foi automática).
      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });
      expect(whatsapp.sendMessage).not.toHaveBeenCalledWith(
        userId,
        expect.stringContaining("De 1 a 5")
      );
    });

    // PEDIDO DO USUÁRIO (2026-07-27): "quando clicar em reabrir não mande a
    // saudação com o nome do funcionário... por determinado tempo" — mesmo
    // pra tickets fechados/avaliados há DIAS (o caso que motivou o pedido:
    // cliente reengaja bem depois, atendente clica "Reabrir" na aba
    // Fechados). Substitui o teste antigo, que travava o comportamento
    // OPOSTO (reabertura manual sempre reenviava a saudação) — ver
    // foiReabertoManualmenteRecente() em ticket.service.js.
    test("reabertura MANUAL (botão 'Reabrir' em Fechados) DENTRO da janela (240min/4h) também pula a saudação", async () => {
      const userId = "u-ciclo-2";
      const ticket = await criarTicket(ADMIN, userId);

      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}/assign`).send({});
      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });
      whatsapp.sendMessage.mockClear();

      // Reabertura MANUAL via PATCH (não via reopenTicketIfClosed) — o
      // atendente decidiu reabrir, ex. da aba Fechados, pouco tempo depois.
      await request(buildApp(ADMIN)).patch(`/api/tickets/${ticket.id}`).send({ status: "aberto" });

      const outroAtendente = { id: "at-3", nome: "Bruno", perfil: "atendente", sector: "vendas" };
      await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}/assign`).send({});

      expect(whatsapp.sendMessage).not.toHaveBeenCalledWith(
        userId,
        expect.stringContaining("Me chamo")
      );
    });

    test("reabertura MANUAL bem depois da janela (240min+) volta a mandar a saudação normalmente — atendimento genuinamente novo", async () => {
      const userId = "u-ciclo-3";
      const ticket = await criarTicket(ADMIN, userId);

      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}/assign`).send({});
      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}`).send({ status: "resolvido" });
      whatsapp.sendMessage.mockClear();

      await request(buildApp(ADMIN)).patch(`/api/tickets/${ticket.id}`).send({ status: "aberto" });

      // Avança o relógio além da janela de reabertura ANTES de assumir —
      // simula o atendente reabrindo agora, mas só assumindo de fato bem
      // mais tarde (ou o relógio real passando dessa janela).
      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => realNow + 241 * 60 * 1000);
      try {
        const outroAtendente = { id: "at-4", nome: "Diego", perfil: "atendente", sector: "vendas" };
        await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}/assign`).send({});

        expect(whatsapp.sendMessage).toHaveBeenCalledWith(
          userId,
          expect.stringContaining("Me chamo")
        );
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe("PATCH /tickets/:id/assign", () => {
    async function criarTicket(user) {
      const res = await request(buildApp(user)).post("/api/tickets").send({ userId: "u1", type: "orcamento" });
      return res.body.ticket;
    }

    test("ticket inexistente → 404", async () => {
      const res = await request(buildApp(ATENDENTE_VENDAS)).patch("/api/tickets/nao-existe/assign").send({});
      expect(res.status).toBe(404);
    });

    test("assume com sucesso e pausa o bot via humanMode.ativar", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}/assign`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ticket.assignedTo).toBe("at-vendas");
      expect(humanMode.ativar).toHaveBeenCalledWith("u1", expect.objectContaining({ agentName: "Bruno" }));
    });

    test("ticket já assumido por outro → 409 com o nome de quem assumiu na mensagem", async () => {
      const ticket = await criarTicket(ADMIN);
      await request(buildApp(ATENDENTE_VENDAS)).patch(`/api/tickets/${ticket.id}/assign`).send({});

      const outroAtendente = { id: "at-2", nome: "Carla", perfil: "atendente", sector: "vendas" };
      const res = await request(buildApp(outroAtendente)).patch(`/api/tickets/${ticket.id}/assign`).send({});

      expect(res.status).toBe(409);
      // ATENDENTE_VENDAS assumiu antes — a mensagem deve nomeá-lo em vez de
      // só dizer "outro atendente" (usuário pediu essa melhoria de UX).
      expect(res.body.assignedToName).toBe("Bruno");
      expect(res.body.error).toMatch(/Bruno/);
    });

    // Pedido do usuário: ao aceitar, o cliente recebe automaticamente uma
    // saudação (mesmo número do bot) se apresentando com o nome de quem
    // assumiu, usando o template configurável em settings (atendimento.
    // mensagemSaudacaoAtendente, "{nome}" → nome do atendente/supervisor).
    test("BUG CORRIGIDO: envia saudação automática ao cliente com o nome de quem assumiu", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}/assign`)
        .send({});

      expect(res.status).toBe(200);
      expect(whatsapp.sendMessage).toHaveBeenCalledWith(
        "u1",
        expect.stringContaining("Bruno")
      );
      expect(historyService.saveHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "u1", sector: "manual", response: expect.stringContaining("Bruno") })
      );
    });

    test("template de saudação vazio (desativado nas configurações) → não envia mensagem nenhuma", async () => {
      settingsService.getSettings.mockResolvedValueOnce({ atendimento: { mensagemSaudacaoAtendente: "" } });

      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}/assign`)
        .send({});

      expect(res.status).toBe(200);
      expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });

    test("falha ao enviar a saudação não impede o aceite do ticket (best-effort)", async () => {
      whatsapp.sendMessage.mockRejectedValueOnce(new Error("WhatsApp indisponível"));

      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}/assign`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.ticket.assignedTo).toBe("at-vendas");
    });
  });

  describe("PATCH /tickets/:id/transfer", () => {
    async function criarTicket(user) {
      const res = await request(buildApp(user)).post("/api/tickets").send({ userId: "u1", type: "orcamento" });
      return res.body.ticket;
    }

    test("setor inválido → 400", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}/transfer`)
        .send({ sector: "setor-fantasma" });
      expect(res.status).toBe(400);
    });

    test("nem sector nem toUserId informado → 400", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}/transfer`)
        .send({});
      expect(res.status).toBe(400);
    });

    test("toUserId de atendente inexistente → 404", async () => {
      const ticket = await criarTicket(ADMIN);
      userRepository.findById.mockResolvedValueOnce(null);

      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}/transfer`)
        .send({ toUserId: "fantasma" });

      expect(res.status).toBe(404);
    });

    test("transferência por setor tem sucesso", async () => {
      const ticket = await criarTicket(ADMIN);
      const res = await request(buildApp(ADMIN))
        .patch(`/api/tickets/${ticket.id}/transfer`)
        .send({ sector: "financeiro" });

      expect(res.status).toBe(200);
      expect(res.body.ticket.sector).toBe("financeiro");
    });
  });

  describe("GET /tickets/dashboard", () => {
    test("atendente comum não pode ver o dashboard sensível → 403", async () => {
      const res = await request(buildApp(ATENDENTE_VENDAS)).get("/api/tickets/dashboard");
      expect(res.status).toBe(403);
    });

    test("admin acessa o dashboard normalmente", async () => {
      const res = await request(buildApp(ADMIN)).get("/api/tickets/dashboard");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("porStatus");
      expect(res.body).toHaveProperty("porSetor");
    });
  });
});
