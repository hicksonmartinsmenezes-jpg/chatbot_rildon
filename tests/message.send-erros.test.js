/** POST /api/messages/send: erros de envio viram status/mensagem úteis (não 500 genérico). */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/config/whatsapp", () => ({
  sendMessage: jest.fn(),
  sendMedia: jest.fn(),
  sendTypingPresence: jest.fn().mockResolvedValue(undefined),
  forceReconnect: jest.fn().mockResolvedValue(undefined),
  getConnectionInfo: jest.fn().mockReturnValue({ connected: true, qr: null })
}));
jest.mock("../src/services/history.service", () => ({ saveHistory: jest.fn().mockResolvedValue({ id: "h" }) }));
jest.mock("../src/repositories/history.repository", () => ({ findAll: jest.fn().mockResolvedValue([]) }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/humanMode.service", () => ({
  ativar: jest.fn(), desativar: jest.fn(), listar: jest.fn().mockReturnValue([]), estaAtivo: jest.fn().mockReturnValue(false)
}));
jest.mock("../src/services/audit.service", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/whatsapp/contacts", () => ({ buscarNomeContatoReal: jest.fn().mockResolvedValue("Cliente") }));
jest.mock("../src/whatsapp/lid-map", () => ({ getProfilePhotoCandidates: jest.fn((id) => [id]) }));

const express = require("express");
const request = require("supertest");
const whatsapp = require("../src/config/whatsapp");
const messageRoutes = require("../src/routes/message.routes");

const ADMIN = { id: "admin-1", nome: "Ana", perfil: "admin", sector: "geral" };
const USER_ID = "55999999999@s.whatsapp.net";

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = ADMIN; req.ip = "127.0.0.1"; next(); });
  a.use("/api", messageRoutes);
  return a;
}
const enviar = () => request(app()).post("/api/messages/send").send({ userId: USER_ID, message: "oi" });

describe("erros de envio", () => {
  beforeEach(() => jest.clearAllMocks());

  test("WhatsApp desconectado → 503 com mensagem do QR", async () => {
    whatsapp.sendMessage.mockRejectedValue(new Error("WhatsApp não autenticado. Escaneie o QR Code no painel."));
    const res = await enviar();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/QR Code/);
  });

  test("número fora do WhatsApp → 422 com o motivo", async () => {
    whatsapp.sendMessage.mockRejectedValue(new Error("Número 5599 não está registrado no WhatsApp."));
    const res = await enviar();
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/não está registrado/);
  });

  test("erro desconhecido continua 500 genérico (sem vazar detalhe)", async () => {
    whatsapp.sendMessage.mockRejectedValue(new Error("boom interno"));
    const res = await enviar();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Erro ao enviar mensagem.");
  });
});
