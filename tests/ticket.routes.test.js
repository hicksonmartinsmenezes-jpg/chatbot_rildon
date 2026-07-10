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

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const humanMode = require("../src/services/humanMode.service");
const userRepository = require("../src/repositories/user.repository");
const ticketRoutes = require("../src/routes/ticket.routes");

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
      return { rows: [t] };
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

    test("atendente sem gerência sobre o ticket → 403 (canManageTicket, modo restrito)", async () => {
      // Só no modo restrito (ATTENDANT_CONVERSATIONS_FULL_ACCESS=false) o
      // atendente fica limitado a tickets atribuídos a ele — no modo padrão
      // (default) ele tem acesso total, como admin (ver access-control.test.js).
      process.env[FULL_ACCESS_ENV_KEY] = "false";

      const ticket = await criarTicket(ADMIN); // ninguém assumiu ainda
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .patch(`/api/tickets/${ticket.id}`)
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
