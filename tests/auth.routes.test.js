/**
 * Testes de auth.routes.js — login, 2FA (challenge de login) e sessão.
 *
 * Mocka só a fronteira com o banco (../database/postgres) e o serviço de
 * auditoria (activityLog.service, que grava em outra tabela e não é o foco
 * aqui). user.service/user.repository/twoFactor.service rodam de verdade
 * por cima do pool mockado — mais próximo de um teste de integração real
 * do que mockar cada camada.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/activityLog.service", () => ({
  addLog: jest.fn().mockResolvedValue(undefined)
}));

const express = require("express");
const cookieParser = require("cookie-parser");
const request = require("supertest");
const bcrypt = require("bcrypt");

const pool = require("../src/database/postgres");
const { authenticator } = require("otplib");

const SENHA_PLANA = "SenhaForte123!";
const SENHA_HASH = bcrypt.hashSync(SENHA_PLANA, 4); // custo baixo só p/ os testes rodarem rápido

function buildState() {
  return {
    users: [
      {
        id: "user-1",
        nome: "Ana Admin",
        usuario: "ana",
        senha: SENHA_HASH,
        perfil: "admin",
        sector: "geral",
        numero: "",
        foto: "",
        ativo: true,
        totp_secret: null,
        totp_pending_secret: null,
        totp_enabled: false,
        totp_backup_codes: null
      },
      {
        id: "user-2fa",
        nome: "Bruno 2FA",
        usuario: "bruno",
        senha: SENHA_HASH,
        perfil: "atendente",
        sector: "vendas",
        numero: "",
        foto: "",
        ativo: true,
        totp_secret: null,
        totp_pending_secret: null,
        totp_enabled: false,
        totp_backup_codes: null
      },
      {
        id: "user-inativo",
        nome: "Carla Inativa",
        usuario: "carla",
        senha: SENHA_HASH,
        perfil: "atendente",
        sector: "geral",
        numero: "",
        foto: "",
        ativo: false,
        totp_secret: null,
        totp_pending_secret: null,
        totp_enabled: false,
        totp_backup_codes: null
      }
    ],
    sessions: new Map(),
    challenges: new Map()
  };
}

function installFakePool(state) {
  pool.query.mockImplementation(async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/^SELECT id, ativo, perfil FROM users WHERE id = \$1/.test(sql)) {
      const u = state.users.find(u => u.id === params[0]);
      return { rows: u ? [{ id: u.id, ativo: u.ativo, perfil: u.perfil }] : [] };
    }
    if (/^SELECT \* FROM users WHERE id = \$1/.test(sql)) {
      const u = state.users.find(u => u.id === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (/FROM users WHERE LOWER\(usuario\)/.test(sql)) {
      const u = state.users.find(
        u => u.usuario.toLowerCase() === String(params[0]).toLowerCase()
      );
      return { rows: u ? [u] : [] };
    }
    if (/^INSERT INTO auth_sessions/.test(sql)) {
      state.sessions.set(params[0], {
        user_data: JSON.parse(params[1]),
        expires_at: params[2]
      });
      return { rows: [] };
    }
    if (/^SELECT token, user_data, expires_at\s*FROM auth_sessions WHERE token = \$1/.test(sql)) {
      const s = state.sessions.get(params[0]);
      return {
        rows: s ? [{ token: params[0], user_data: s.user_data, expires_at: s.expires_at }] : []
      };
    }
    if (/^DELETE FROM auth_sessions WHERE token = \$1/.test(sql)) {
      state.sessions.delete(params[0]);
      return { rows: [] };
    }
    if (/^DELETE FROM auth_sessions WHERE expires_at/.test(sql)) {
      return { rows: [] };
    }
    if (/^INSERT INTO two_factor_challenges/.test(sql)) {
      state.challenges.set(params[0], { user_id: params[1], expires_at: params[2] });
      return { rows: [] };
    }
    if (/^SELECT token, user_id, expires_at FROM two_factor_challenges WHERE token = \$1/.test(sql)) {
      const c = state.challenges.get(params[0]);
      return {
        rows: c ? [{ token: params[0], user_id: c.user_id, expires_at: c.expires_at }] : []
      };
    }
    if (/^DELETE FROM two_factor_challenges WHERE token = \$1/.test(sql)) {
      state.challenges.delete(params[0]);
      return { rows: [] };
    }
    if (/^DELETE FROM two_factor_challenges WHERE expires_at/.test(sql)) {
      return { rows: [] };
    }
    if (/^UPDATE users SET totp_pending_secret/.test(sql)) {
      const u = state.users.find(u => u.id === params[1]);
      if (u) u.totp_pending_secret = params[0];
      return { rows: [] };
    }
    if (/^UPDATE users\s+SET totp_secret = \$1/.test(sql)) {
      const u = state.users.find(u => u.id === params[2]);
      if (u) {
        u.totp_secret = params[0];
        u.totp_pending_secret = null;
        u.totp_enabled = true;
        u.totp_backup_codes = JSON.parse(params[1]);
      }
      return { rows: u ? [u] : [] };
    }

    throw new Error("Query não mapeada no mock de auth.routes.test.js: " + sql);
  });
}

describe("auth.routes", () => {
  let state;
  let app;
  const { router } = require("../src/routes/auth.routes");

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api", router);
  });

  describe("POST /auth/login", () => {
    test("credenciais corretas sem 2FA abre sessão e seta cookie httpOnly", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ usuario: "ana", senha: SENHA_PLANA });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ usuario: "ana", perfil: "admin" });
      expect(res.body.user.senha).toBeUndefined();

      const setCookie = res.headers["set-cookie"] || [];
      expect(setCookie.some(c => c.startsWith("rildon_sid="))).toBe(true);
      expect(setCookie.some(c => /HttpOnly/i.test(c))).toBe(true);
    });

    test("senha errada retorna 401 e não abre sessão", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ usuario: "ana", senha: "senha-errada" });

      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(state.sessions.size).toBe(0);
    });

    test("usuário inexistente retorna 401 (mesma mensagem que senha errada)", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ usuario: "fantasma", senha: "qualquer" });

      expect(res.status).toBe(401);
    });

    test("usuário inativo não consegue logar mesmo com senha certa", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ usuario: "carla", senha: SENHA_PLANA });

      expect(res.status).toBe(401);
    });

    test("usuário com 2FA ativo recebe desafio em vez de sessão aberta", async () => {
      const userComTotp = state.users.find(u => u.usuario === "bruno");
      userComTotp.totp_enabled = true;
      userComTotp.totp_secret = authenticator.generateSecret();

      const res = await request(app)
        .post("/api/auth/login")
        .send({ usuario: "bruno", senha: SENHA_PLANA });

      expect(res.status).toBe(200);
      expect(res.body.requiresTwoFactor).toBe(true);
      expect(res.body.challengeToken).toEqual(expect.any(String));
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(state.sessions.size).toBe(0);
      expect(state.challenges.size).toBe(1);
    });
  });

  describe("POST /auth/login/verify-2fa", () => {
    async function criarDesafioParaBruno() {
      const userComTotp = state.users.find(u => u.usuario === "bruno");
      userComTotp.totp_enabled = true;
      userComTotp.totp_secret = authenticator.generateSecret();

      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ usuario: "bruno", senha: SENHA_PLANA });

      return { challengeToken: loginRes.body.challengeToken, secret: userComTotp.totp_secret };
    }

    test("código TOTP correto abre a sessão", async () => {
      const { challengeToken, secret } = await criarDesafioParaBruno();
      const codigo = authenticator.generate(secret);

      const res = await request(app)
        .post("/api/auth/login/verify-2fa")
        .send({ challengeToken, codigo });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ usuario: "bruno" });
      const setCookie = res.headers["set-cookie"] || [];
      expect(setCookie.some(c => c.startsWith("rildon_sid="))).toBe(true);
      expect(state.challenges.size).toBe(0);
    });

    test("código errado não abre sessão", async () => {
      const { challengeToken } = await criarDesafioParaBruno();

      const res = await request(app)
        .post("/api/auth/login/verify-2fa")
        .send({ challengeToken, codigo: "000000" });

      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    test("challengeToken inválido/expirado retorna 401", async () => {
      const res = await request(app)
        .post("/api/auth/login/verify-2fa")
        .send({ challengeToken: "token-que-nao-existe", codigo: "123456" });

      expect(res.status).toBe(401);
    });

    test("faltando código ou token retorna 400", async () => {
      const res = await request(app).post("/api/auth/login/verify-2fa").send({});
      expect(res.status).toBe(400);
    });
  });

  describe("GET /auth/me", () => {
    test("sem cookie de sessão retorna 401", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
    });

    test("com sessão válida retorna o usuário logado", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ usuario: "ana", senha: SENHA_PLANA });

      const res = await agent.get("/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ usuario: "ana" });
    });

    test("usuário desativado depois do login perde a sessão na próxima requisição", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ usuario: "ana", senha: SENHA_PLANA });

      // Simula desativação do usuário enquanto a sessão ainda existe
      state.users.find(u => u.usuario === "ana").ativo = false;

      const res = await agent.get("/api/auth/me");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/logout", () => {
    test("remove a sessão do banco e limpa o cookie", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ usuario: "ana", senha: SENHA_PLANA });
      expect(state.sessions.size).toBe(1);

      const res = await agent.post("/api/auth/logout");
      expect(res.status).toBe(200);
      expect(state.sessions.size).toBe(0);

      const after = await agent.get("/api/auth/me");
      expect(after.status).toBe(401);
    });
  });

  describe("2FA — setup e confirmação", () => {
    test("setup gera segredo pendente + QR code sem ativar o 2FA ainda", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ usuario: "ana", senha: SENHA_PLANA });

      const res = await agent.post("/api/auth/2fa/setup").send({});
      expect(res.status).toBe(200);
      expect(res.body.secret).toEqual(expect.any(String));
      expect(res.body.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);

      const ana = state.users.find(u => u.usuario === "ana");
      expect(ana.totp_pending_secret).toBe(res.body.secret);
      expect(ana.totp_enabled).toBe(false);
    });

    test("confirm com código certo ativa o 2FA e devolve backup codes uma única vez", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ usuario: "ana", senha: SENHA_PLANA });
      const setupRes = await agent.post("/api/auth/2fa/setup").send({});

      const codigo = authenticator.generate(setupRes.body.secret);
      const res = await agent.post("/api/auth/2fa/confirm").send({ codigo });

      expect(res.status).toBe(200);
      expect(res.body.backupCodes).toHaveLength(8);

      const ana = state.users.find(u => u.usuario === "ana");
      expect(ana.totp_enabled).toBe(true);
    });

    test("confirm com código errado não ativa o 2FA", async () => {
      const agent = request.agent(app);
      await agent.post("/api/auth/login").send({ usuario: "ana", senha: SENHA_PLANA });
      await agent.post("/api/auth/2fa/setup").send({});

      const res = await agent.post("/api/auth/2fa/confirm").send({ codigo: "000000" });
      expect(res.status).toBe(400);

      const ana = state.users.find(u => u.usuario === "ana");
      expect(ana.totp_enabled).toBe(false);
    });
  });
});
