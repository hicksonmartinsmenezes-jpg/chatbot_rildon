/**
 * Testes de user.routes.js — foco no que foi pedido pelo usuário:
 *
 * 1) Vincular um número de telefone/WhatsApp ao CRIAR um usuário
 *    (POST /api/users). createUser()/user.service.js já suportava "numero"
 *    de ponta a ponta (usado há tempos na edição do próprio perfil), mas a
 *    rota de criação não repassava o campo do corpo da requisição — o
 *    telefone enviado no cadastro era silenciosamente ignorado.
 *
 * 2) GET /api/users agora inclui "ticketsAtivos" (contagem de tickets
 *    em_andamento assumidos por aquele usuário) — usado no painel Usuários
 *    para mostrar quem está "em atendimento" agora, ao lado do status
 *    online/offline.
 *
 * Mocka só a fronteira com o banco (postgres), auditoria e socket — o
 * resto (user.service/user.repository) roda de verdade por cima do pool
 * fake, mais próximo de um teste de integração real (mesmo padrão de
 * auth.routes.test.js).
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/audit.service", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const userRoutes = require("../src/routes/user.routes");

function buildState() {
  return { users: [], tickets: [] };
}

let idCounter = 0;
function fakeId() { idCounter += 1; return `user-${idCounter}`; }

function installFakePool(state) {
  pool.query.mockImplementation(async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/^SELECT \* FROM users WHERE id = \$1 LIMIT 1/.test(sql)) {
      const u = state.users.find(x => x.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/^SELECT \* FROM users WHERE \(\$1::boolean = true OR ativo = true\)/.test(sql)) {
      const includeInactive = params[0] === true;
      const rows = state.users.filter(u => includeInactive || u.ativo !== false);
      return { rows };
    }
    if (/^SELECT \* FROM users WHERE LOWER\(usuario\) = LOWER\(\$1\)/.test(sql)) {
      const u = state.users.find(x => x.usuario.toLowerCase() === String(params[0]).toLowerCase());
      return { rows: u ? [u] : [] };
    }
    if (/^INSERT INTO users/.test(sql)) {
      const row = {
        id: params[0], nome: params[1], usuario: params[2], senha: params[3],
        perfil: params[4], sector: params[5], numero: params[6], foto: params[7],
        ativo: params[8],
        totp_secret: null, totp_pending_secret: null, totp_enabled: false, totp_backup_codes: null,
        created_at: new Date(), updated_at: new Date()
      };
      state.users.push(row);
      return { rows: [row] };
    }
    if (/^SELECT COUNT\(\*\)::int AS total FROM users WHERE ativo = true AND perfil = 'admin'/.test(sql)) {
      return { rows: [{ total: state.users.filter(u => u.ativo && u.perfil === "admin").length }] };
    }
    if (/^SELECT assigned_to, COUNT\(\*\)::int AS total FROM tickets/.test(sql)) {
      const porUsuario = new Map();
      for (const t of state.tickets) {
        if (t.status === "em_andamento" && t.assigned_to) {
          porUsuario.set(t.assigned_to, (porUsuario.get(t.assigned_to) || 0) + 1);
        }
      }
      return { rows: [...porUsuario.entries()].map(([assigned_to, total]) => ({ assigned_to, total })) };
    }
    if (/^DELETE FROM auth_sessions/.test(sql)) return { rows: [] };
    if (/^UPDATE users SET ativo = false/.test(sql)) {
      const u = state.users.find(x => x.id === params[0]);
      if (u) u.ativo = false;
      return { rows: u ? [u] : [] };
    }
    if (/^UPDATE users\s+SET senha = \$1/.test(sql)) {
      const u = state.users.find(x => x.id === params[1]);
      if (u) u.senha = params[0];
      return { rows: u ? [u] : [] };
    }
    if (/^UPDATE users\s+SET nome\s+= \$1/.test(sql)) {
      // Reativação (userRepository.reactivate) — usuário existente
      // (ativo=false) é atualizado em vez de inserido de novo, já que
      // "usuario" tem UNIQUE NOT NULL.
      const u = state.users.find(x => x.id === params[6]);
      if (!u) return { rows: [] };
      u.nome = params[0]; u.senha = params[1]; u.perfil = params[2];
      u.sector = params[3]; u.numero = params[4]; u.foto = params[5];
      u.ativo = true;
      return { rows: [u] };
    }

    throw new Error("Query não mapeada: " + sql);
  });
}

function buildApp(currentUser) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api", userRoutes);
  return app;
}

const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };

describe("POST /api/users — vincula numero (telefone) ao cadastrar", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    idCounter = 0;
    state = buildState();
    installFakePool(state);
  });

  test("numero enviado no cadastro é salvo e retornado (antes era ignorado pela rota)", async () => {
    const app = buildApp(ADMIN);

    const res = await request(app).post("/api/users").send({
      nome: "Bruno Atendente",
      usuario: "bruno",
      senha: "4821", // PINs óbvios como "1234" são bloqueados (ver passwordPolicy.js)
      perfil: "atendente",
      sector: "vendas",
      numero: "5579999998888"
    });

    expect(res.status).toBe(201);
    expect(res.body.numero).toBe("5579999998888");
    expect(state.users[0].numero).toBe("5579999998888");
  });

  // Bug achado escrevendo os testes acima: createUser() gravava "numero"
  // certinho no banco (via userRepository.create), mas o objeto retornado
  // pela rota OMITIA numero/foto — o painel só mostrava o telefone recém
  // cadastrado depois de recarregar a lista. Mesmo bug no branch de
  // reativação (usuário excluído e recriado com o mesmo "usuario").
  test("reativar usuário excluído com numero novo → resposta já vem com o numero atualizado", async () => {
    const app = buildApp(ADMIN);

    await request(app).post("/api/users").send({
      nome: "Fábio Atendente", usuario: "fabio", senha: "5137", perfil: "atendente", sector: "geral"
    });
    const fabioId = state.users.find(u => u.usuario === "fabio").id;
    await request(app).delete(`/api/users/${fabioId}`);

    const res = await request(app).post("/api/users").send({
      nome: "Fábio Atendente", usuario: "fabio", senha: "9406", perfil: "atendente", sector: "geral",
      numero: "5579988887777"
    });

    expect(res.status).toBe(200); // 200 = reativação, não 201
    expect(res.body.reactivated).toBe(true);
    expect(res.body.numero).toBe("5579988887777");
  });

  test("numero é opcional — cadastro sem telefone continua funcionando (string vazia)", async () => {
    const app = buildApp(ADMIN);

    const res = await request(app).post("/api/users").send({
      nome: "Carla Atendente",
      usuario: "carla",
      senha: "7053",
      perfil: "atendente",
      sector: "geral"
    });

    expect(res.status).toBe(201);
    expect(res.body.numero).toBe("");
  });
});

describe("GET /api/users — ticketsAtivos (status 'em atendimento' no painel)", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    idCounter = 0;
    state = buildState();
    installFakePool(state);
  });

  test("usuário com ticket em_andamento assumido → ticketsAtivos > 0", async () => {
    const app = buildApp(ADMIN);

    await request(app).post("/api/users").send({
      nome: "Diego Atendente", usuario: "diego", senha: "6284", perfil: "atendente", sector: "geral"
    });
    const diegoId = state.users.find(u => u.usuario === "diego").id;

    state.tickets.push(
      { id: 1, status: "em_andamento", assigned_to: diegoId },
      { id: 2, status: "em_andamento", assigned_to: diegoId },
      { id: 3, status: "resolvido", assigned_to: diegoId } // não conta — já fechado
    );

    const res = await request(app).get("/api/users");
    const diego = res.body.find(u => u.usuario === "diego");

    expect(diego.ticketsAtivos).toBe(2);
  });

  test("usuário sem ticket em_andamento → ticketsAtivos é 0, não undefined", async () => {
    const app = buildApp(ADMIN);

    await request(app).post("/api/users").send({
      nome: "Elis Atendente", usuario: "elis", senha: "3947", perfil: "atendente", sector: "geral"
    });

    const res = await request(app).get("/api/users");
    const elis = res.body.find(u => u.usuario === "elis");

    expect(elis.ticketsAtivos).toBe(0);
  });
});
