/**
 * Gates de acesso por tela em app.js (varredura 2026-09-30): o gate de uma
 * tela só pode barrar as rotas dela, nunca as de outras telas.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("qrcode-terminal", () => ({ generate: jest.fn() }));
jest.mock("@whiskeysockets/baileys", () => ({
  __esModule: true,
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0] }),
  downloadMediaMessage: jest.fn()
}));

const request = require("supertest");
const pool = require("../src/database/postgres");

const SESSAO = "a".repeat(64);

function sessaoComo(user) {
  pool.query.mockImplementation(async (text) => {
    const sql = String(text).replace(/\s+/g, " ").trim();
    if (/FROM auth_sessions WHERE token/.test(sql)) {
      return { rows: [{ token: SESSAO, user_data: user, expires_at: Date.now() + 600000 }] };
    }
    if (/SELECT id, ativo, perfil/.test(sql)) {
      return { rows: [{ id: user.id, ativo: true, perfil: user.perfil, permissions: user.permissions || {} }] };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe("app.js — gates por tela", () => {
  let app;
  beforeAll(() => { app = require("../src/app"); });

  test("atendente sem Contatos/Campanhas ainda acessa Tickets", async () => {
    sessaoComo({ id: "u1", nome: "A", usuario: "a", perfil: "atendente", permissions: { contacts: false, channels: false } });
    const res = await request(app).get("/api/tickets").set("Cookie", `rildon_sid=${SESSAO}`);
    expect(res.status).not.toBe(403);
  });

  test("mas continua barrado em Contatos", async () => {
    sessaoComo({ id: "u1", nome: "A", usuario: "a", perfil: "atendente", permissions: { contacts: false, channels: false } });
    const res = await request(app).get("/api/contacts").set("Cookie", `rildon_sid=${SESSAO}`);
    expect(res.status).toBe(403);
  });

  test("atendente padrão lê Respostas Rápidas mas não edita", async () => {
    sessaoComo({ id: "u2", nome: "B", usuario: "b", perfil: "atendente" });
    const get = await request(app).get("/api/quick-replies").set("Cookie", `rildon_sid=${SESSAO}`);
    const put = await request(app).put("/api/quick-replies").set("Cookie", `rildon_sid=${SESSAO}`).send([]);
    expect(get.status).not.toBe(403);
    expect(put.status).toBe(403);
  });

  test("MCP responde 404 (desligado) em vez de 401 de sessão", async () => {
    const res = await request(app).post("/api/mcp").send({});
    expect([404]).toContain(res.status);
  });
});
