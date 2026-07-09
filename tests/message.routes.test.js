/**
 * Testes de message.routes.js — envio manual de mensagem, "digitando...",
 * atendimento humano (listar/devolver ao bot) e reconexão do WhatsApp.
 *
 * O ponto mais sensível aqui é canUserAccessConversation() (message.controller.js):
 * decide se um atendente pode enviar mensagem/typing/liberar uma conversa —
 * roda de verdade sobre ticketRepository.findByUserId (pool mockado), só a
 * fronteira com WhatsApp/socket/histórico/auditoria é mockada.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/config/whatsapp", () => ({
  sendMessage: jest.fn(),
  sendTypingPresence: jest.fn().mockResolvedValue(undefined),
  forceReconnect: jest.fn().mockResolvedValue(undefined),
  getConnectionInfo: jest.fn().mockReturnValue({ connected: true, qr: null })
}));
jest.mock("../src/services/history.service", () => ({
  saveHistory: jest.fn().mockResolvedValue({ id: "hist-1" })
}));
jest.mock("../src/services/socket.service", () => ({
  emitEvent: jest.fn()
}));
jest.mock("../src/services/humanMode.service", () => ({
  ativar: jest.fn(),
  desativar: jest.fn(),
  listar: jest.fn().mockReturnValue(["55999@s.whatsapp.net"]),
  estaAtivo: jest.fn().mockReturnValue(false),
  renovar: jest.fn(),
  carregar: jest.fn().mockResolvedValue(undefined)
}));
jest.mock("../src/services/audit.service", () => ({
  auditLog: jest.fn().mockResolvedValue(undefined)
}));

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const whatsapp = require("../src/config/whatsapp");
const historyService = require("../src/services/history.service");
const socketService = require("../src/services/socket.service");
const humanMode = require("../src/services/humanMode.service");
const auditService = require("../src/services/audit.service");
const messageRoutes = require("../src/routes/message.routes");

const USER_ID = "55999999999@s.whatsapp.net";

function buildState() {
  return { tickets: [] };
}

function installFakePool(state) {
  pool.query.mockImplementation(async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/^SELECT contact_name FROM history/.test(sql)) {
      return { rows: [{ contact_name: "Cliente Teste" }] };
    }

    if (/^SELECT \* FROM tickets WHERE user_id = \$1/.test(sql)) {
      return { rows: state.tickets.filter(t => t.user_id === params[0]) };
    }

    throw new Error("Query não mapeada no mock de message.routes.test.js: " + sql);
  });
}

function buildApp(currentUser) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = currentUser;
    req.ip = "127.0.0.1";
    next();
  });
  app.use("/api", messageRoutes);
  return app;
}

const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };
const ATENDENTE_VENDAS = { id: "at-1", nome: "Bruno", usuario: "bruno", perfil: "atendente", sector: "vendas" };

const FULL_ACCESS_ENV_KEY = "ATTENDANT_CONVERSATIONS_FULL_ACCESS";
const ORIGINAL_FULL_ACCESS_ENV = process.env[FULL_ACCESS_ENV_KEY];

describe("message.routes", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
    whatsapp.sendMessage.mockResolvedValue({ id: "wamid-1", remoteJid: USER_ID, fromMe: true });
  });

  afterEach(() => {
    if (ORIGINAL_FULL_ACCESS_ENV === undefined) delete process.env[FULL_ACCESS_ENV_KEY];
    else process.env[FULL_ACCESS_ENV_KEY] = ORIGINAL_FULL_ACCESS_ENV;
  });

  describe("POST /messages/send", () => {
    test("userId ausente → 400", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/send").send({ message: "oi" });
      expect(res.status).toBe(400);
    });

    test("message ausente → 400", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/send").send({ userId: USER_ID });
      expect(res.status).toBe(400);
    });

    test("message vazia (só espaços) → 400", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/send").send({ userId: USER_ID, message: "   " });
      expect(res.status).toBe(400);
    });

    test("message maior que 4096 caracteres → 400", async () => {
      const res = await request(buildApp(ADMIN))
        .post("/api/messages/send")
        .send({ userId: USER_ID, message: "a".repeat(4097) });
      expect(res.status).toBe(400);
    });

    test("atendente sem ticket ativo na conversa → 403 (modo restrito)", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";

      const res = await request(buildApp(ATENDENTE_VENDAS))
        .post("/api/messages/send")
        .send({ userId: USER_ID, message: "Olá, tudo bem?" });

      expect(res.status).toBe(403);
      expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });

    test("atendente com ticket aberto não atribuído do mesmo setor → sucesso (modo restrito)", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      state.tickets.push({
        id: "t1", protocolo: "2026-0001", user_id: USER_ID, customer_name: "Cliente",
        cpf: "", type: "orcamento", sector: "vendas", description: "", status: "aberto",
        assigned_to: null, assigned_to_name: null, created_at: new Date(), updated_at: new Date()
      });

      const res = await request(buildApp(ATENDENTE_VENDAS))
        .post("/api/messages/send")
        .send({ userId: USER_ID, message: "Olá, tudo bem?" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test("admin envia mensagem com sucesso: chama sendMessage, pausa o bot e salva histórico", async () => {
      const res = await request(buildApp(ADMIN))
        .post("/api/messages/send")
        .send({ userId: USER_ID, message: "  Olá!  " });

      expect(res.status).toBe(200);
      expect(whatsapp.sendMessage).toHaveBeenCalledWith(USER_ID, "Olá!");
      expect(humanMode.ativar).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ agentName: "Ana Admin" }));
      expect(historyService.saveHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, response: "Olá!", sector: "manual" })
      );
      expect(socketService.emitEvent).toHaveBeenCalledWith("nova_mensagem", expect.objectContaining({ userId: USER_ID }));
      expect(res.body.messageId).toBe("wamid-1");
    });

    test("falha ao salvar histórico não derruba a resposta (best-effort)", async () => {
      historyService.saveHistory.mockRejectedValueOnce(new Error("db fora do ar"));

      const res = await request(buildApp(ADMIN))
        .post("/api/messages/send")
        .send({ userId: USER_ID, message: "Olá!" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.history).toBeNull();
    });
  });

  describe("POST /messages/typing", () => {
    test("userId ausente → 400", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/typing").send({});
      expect(res.status).toBe(400);
    });

    test("atendente sem acesso à conversa → 403", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const res = await request(buildApp(ATENDENTE_VENDAS)).post("/api/messages/typing").send({ userId: USER_ID });
      expect(res.status).toBe(403);
      expect(whatsapp.sendTypingPresence).not.toHaveBeenCalled();
    });

    test("sucesso: emite evento typing e chama sendTypingPresence", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/typing").send({ userId: USER_ID });
      expect(res.status).toBe(200);
      expect(socketService.emitEvent).toHaveBeenCalledWith("typing", { userId: USER_ID, from: "agent" });
      expect(whatsapp.sendTypingPresence).toHaveBeenCalledWith(USER_ID);
    });
  });

  describe("GET /messages/humanmode", () => {
    test("lista os usuários em atendimento humano", async () => {
      const res = await request(buildApp(ADMIN)).get("/api/messages/humanmode");
      expect(res.status).toBe(200);
      expect(res.body.users).toEqual(["55999@s.whatsapp.net"]);
    });
  });

  describe("POST /messages/humanmode/release", () => {
    test("userId ausente → 400", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/humanmode/release").send({});
      expect(res.status).toBe(400);
    });

    test("atendente sem acesso à conversa → 403", async () => {
      process.env[FULL_ACCESS_ENV_KEY] = "false";
      const res = await request(buildApp(ATENDENTE_VENDAS))
        .post("/api/messages/humanmode/release")
        .send({ userId: USER_ID });
      expect(res.status).toBe(403);
      expect(humanMode.desativar).not.toHaveBeenCalled();
    });

    test("sucesso: devolve a conversa ao bot", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/messages/humanmode/release").send({ userId: USER_ID });
      expect(res.status).toBe(200);
      expect(humanMode.desativar).toHaveBeenCalledWith(USER_ID, "painel");
    });
  });

  describe("GET /whatsapp/status", () => {
    test("devolve as informações de conexão atuais", async () => {
      const res = await request(buildApp(ADMIN)).get("/api/whatsapp/status");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ connected: true, qr: null });
    });
  });

  describe("POST /whatsapp/reconnect", () => {
    test("usuário não privilegiado → 403", async () => {
      const res = await request(buildApp(ATENDENTE_VENDAS)).post("/api/whatsapp/reconnect").send({});
      expect(res.status).toBe(403);
      expect(whatsapp.forceReconnect).not.toHaveBeenCalled();
    });

    test("admin reconecta com sucesso e audita a ação", async () => {
      const res = await request(buildApp(ADMIN)).post("/api/whatsapp/reconnect").send({ clearSession: true });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(whatsapp.forceReconnect).toHaveBeenCalledWith({ clearSession: true });
      expect(auditService.auditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: "WHATSAPP_REPAIR" })
      );
    });

    test("falha na reconexão → 500", async () => {
      whatsapp.forceReconnect.mockRejectedValueOnce(new Error("sessão corrompida"));
      const res = await request(buildApp(ADMIN)).post("/api/whatsapp/reconnect").send({});
      expect(res.status).toBe(500);
    });
  });
});
