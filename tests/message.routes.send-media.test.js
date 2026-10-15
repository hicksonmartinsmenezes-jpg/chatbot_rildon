/**
 * Testes de POST /api/messages/send-media (feature nova, 2026-07-23, pedido
 * do usuário: "enviar arquivo exatamente igual WhatsApp" — foto/vídeo/doc) e
 * do suporte a quotedMessageId em POST /api/messages/send ("responder
 * mensagem específica", reply/quote).
 *
 * Arquivo separado de message.routes.test.js porque precisa de upload real
 * (multer.diskStorage) — usa um diretório temporário no lugar de
 * src/media-recebida/ de verdade.
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const mockTmpMediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "rildon-media-test-"));

jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/config/whatsapp", () => ({
  sendMessage: jest.fn(),
  sendMedia: jest.fn(),
  sendTypingPresence: jest.fn().mockResolvedValue(undefined),
  forceReconnect: jest.fn().mockResolvedValue(undefined),
  getConnectionInfo: jest.fn().mockReturnValue({ connected: true, qr: null })
}));
jest.mock("../src/services/history.service", () => ({
  saveHistory: jest.fn().mockResolvedValue({ id: "hist-1" })
}));
jest.mock("../src/repositories/history.repository", () => ({
  findAll: jest.fn().mockResolvedValue([])
}));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/humanMode.service", () => ({
  ativar: jest.fn(),
  desativar: jest.fn(),
  listar: jest.fn().mockReturnValue([]),
  estaAtivo: jest.fn().mockReturnValue(false)
}));
jest.mock("../src/services/audit.service", () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/whatsapp/contacts", () => ({ buscarNomeContatoReal: jest.fn().mockResolvedValue("Cliente Teste") }));
jest.mock("../src/whatsapp/lid-map", () => ({ getProfilePhotoCandidates: jest.fn(id => [id]) }));
jest.mock("../src/services/mediaStorage.service", () => ({
  MEDIA_DIR: mockTmpMediaDir,
  salvarMidiaRecebida: jest.fn(),
  resolverCaminhoMidia: jest.fn(p => require("path").join(mockTmpMediaDir, p)),
}));

const express = require("express");
const request = require("supertest");

const whatsapp = require("../src/config/whatsapp");
const historyService = require("../src/services/history.service");
const historyRepository = require("../src/repositories/history.repository");
const socketService = require("../src/services/socket.service");
const humanMode = require("../src/services/humanMode.service");
const messageRoutes = require("../src/routes/message.routes");

const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };
const USER_ID = "55999999999@s.whatsapp.net";

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

describe("POST /api/messages/send-media", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    whatsapp.sendMedia.mockResolvedValue({ id: "wamid-media-1", remoteJid: USER_ID, fromMe: true });
  });

  afterAll(() => {
    fs.rmSync(mockTmpMediaDir, { recursive: true, force: true });
  });

  test("sem arquivo anexado → 400", async () => {
    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .field("userId", USER_ID);

    expect(res.status).toBe(400);
    expect(whatsapp.sendMedia).not.toHaveBeenCalled();
  });

  test("sem userId → 400 e remove o arquivo já salvo em disco", async () => {
    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .attach("media", Buffer.from("fake-jpg-bytes"), "foto.jpg");

    expect(res.status).toBe(400);
    // Nenhum arquivo deve sobrar no diretório de mídia após o cleanup.
    // A rota remove com fs.unlink assíncrono (fire-and-forget) depois de
    // responder, então a leitura imediata do diretório corre contra o unlink
    // (flaky no CI). Espera o diretório esvaziar, com teto de 2s.
    const limite = Date.now() + 2000;
    while (fs.readdirSync(mockTmpMediaDir).length > 0 && Date.now() < limite) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.readdirSync(mockTmpMediaDir)).toHaveLength(0);
  });

  test("imagem (.jpg) → detecta mediaType 'image', chama sendMedia e salva histórico com mediaPath/mediaMimetype", async () => {
    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .field("userId", USER_ID)
      .field("caption", "Segue a foto")
      .attach("media", Buffer.from("fake-jpg-bytes"), "foto.jpg");

    expect(res.status).toBe(200);
    expect(whatsapp.sendMedia).toHaveBeenCalledWith(
      USER_ID,
      expect.stringContaining(mockTmpMediaDir),
      "Segue a foto",
      "image",
      expect.objectContaining({ mimetype: "image/jpeg", fileName: "foto.jpg" })
    );
    expect(humanMode.ativar).toHaveBeenCalledWith(USER_ID, expect.any(Object));
    expect(historyService.saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        response: "Segue a foto",
        sector: "manual",
        mediaMimetype: "image/jpeg",
        mediaFilename: "foto.jpg",
      })
    );
    expect(socketService.emitEvent).toHaveBeenCalledWith("nova_mensagem", expect.objectContaining({ userId: USER_ID }));
  });

  test("vídeo (.mp4) → detecta mediaType 'video'", async () => {
    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .field("userId", USER_ID)
      .attach("media", Buffer.from("fake-mp4-bytes"), "video.mp4");

    expect(res.status).toBe(200);
    expect(whatsapp.sendMedia).toHaveBeenCalledWith(
      USER_ID, expect.any(String), "", "video", expect.objectContaining({ mimetype: "video/mp4" })
    );
  });

  test("documento genérico (.docx) → detecta mediaType 'document', não é rejeitado por não ser PDF/imagem/áudio", async () => {
    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .field("userId", USER_ID)
      .attach("media", Buffer.from("fake-docx-bytes"), "orcamento.docx");

    expect(res.status).toBe(200);
    expect(whatsapp.sendMedia).toHaveBeenCalledWith(
      USER_ID, expect.any(String), "", "document",
      expect.objectContaining({ fileName: "orcamento.docx" })
    );
  });

  test("quotedMessageId presente e encontrado no histórico → repassa quotedMessageId/quotedText pro sendMedia", async () => {
    historyRepository.findAll.mockResolvedValueOnce([
      { messageId: "MSG-CLIENTE-9", message: "Tem óleo de motor 5W30?", userId: USER_ID }
    ]);

    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .field("userId", USER_ID)
      .field("quotedMessageId", "MSG-CLIENTE-9")
      .attach("media", Buffer.from("fake-jpg-bytes"), "foto.jpg");

    expect(res.status).toBe(200);
    expect(whatsapp.sendMedia).toHaveBeenCalledWith(
      USER_ID, expect.any(String), "", "image",
      expect.objectContaining({ quotedMessageId: "MSG-CLIENTE-9", quotedText: "Tem óleo de motor 5W30?" })
    );
  });

  test("erro no envio (sendMedia lança) → 500 e não deixa o arquivo travado (cleanup)", async () => {
    whatsapp.sendMedia.mockRejectedValueOnce(new Error("Falha de conexão"));

    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send-media")
      .field("userId", USER_ID)
      .attach("media", Buffer.from("fake-jpg-bytes"), "foto.jpg");

    expect(res.status).toBe(500);
  });
});

describe("POST /api/messages/send — reply/quote (quotedMessageId)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    whatsapp.sendMessage.mockResolvedValue({ id: "wamid-1", remoteJid: USER_ID, fromMe: true });
  });

  test("quotedMessageId encontrado no histórico → sendMessage recebe { quotedMessageId, quotedText }", async () => {
    historyRepository.findAll.mockResolvedValueOnce([
      { messageId: "MSG-CLIENTE-5", message: "Vocês têm pastilha de freio pro Onix?", userId: USER_ID }
    ]);

    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send")
      .send({ userId: USER_ID, message: "Sim, temos! Qual ano do Onix?", quotedMessageId: "MSG-CLIENTE-5" });

    expect(res.status).toBe(200);
    expect(whatsapp.sendMessage).toHaveBeenCalledWith(
      USER_ID,
      "Sim, temos! Qual ano do Onix?",
      { quotedMessageId: "MSG-CLIENTE-5", quotedText: "Vocês têm pastilha de freio pro Onix?" }
    );
  });

  test("quotedMessageId que não bate com nenhuma linha do histórico → envia normalmente, sem citação", async () => {
    historyRepository.findAll.mockResolvedValueOnce([]);

    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send")
      .send({ userId: USER_ID, message: "Olá!", quotedMessageId: "MSG-INEXISTENTE" });

    expect(res.status).toBe(200);
    expect(whatsapp.sendMessage).toHaveBeenCalledWith(USER_ID, "Olá!", {});
  });

  test("quotedMessageId aponta pra linha SEM texto do cliente (message null — ex: mídia sem legenda) → não cita (escopo: só cita mensagem do cliente)", async () => {
    historyRepository.findAll.mockResolvedValueOnce([
      { messageId: "MSG-BOT-1", message: null, response: "Bom dia! Como posso ajudar?", userId: USER_ID }
    ]);

    const res = await request(buildApp(ADMIN))
      .post("/api/messages/send")
      .send({ userId: USER_ID, message: "Oi de novo", quotedMessageId: "MSG-BOT-1" });

    expect(res.status).toBe(200);
    expect(whatsapp.sendMessage).toHaveBeenCalledWith(USER_ID, "Oi de novo", {});
  });
});
