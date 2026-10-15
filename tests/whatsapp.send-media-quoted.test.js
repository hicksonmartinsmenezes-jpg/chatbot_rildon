/**
 * Testes de sendMessage/sendMedia (config/whatsapp.js) para a feature nova
 * (2026-07-23, pedido do usuário): "enviar arquivo igual WhatsApp" (foto/
 * vídeo/documento) e "responder mensagem específica" (reply/quote).
 *
 * Cobre: sendMessage aceita { quotedMessageId, quotedText } e monta o objeto
 * "quoted" reduzido que o Baileys precisa pra mostrar a prévia de citação;
 * sendMedia ganhou os tipos "video" e "document" (além de "image"/"pdf"/
 * "audio" já existentes, usados por broadcast.service.js) e também aceita
 * quoted.
 */
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn(async () => ({ ativo: true })),
}));
jest.mock("../src/services/history.service", () => ({ saveHistory: jest.fn(async () => {}) }));
jest.mock("../src/whatsapp/contacts", () => ({
  autoRegisterContact: jest.fn(async () => {}),
  contatoTemTagFuncionario: jest.fn(async () => false),
}));
jest.mock("../src/whatsapp/dedup", () => ({
  isDuplicateContent: jest.fn(() => false),
  marcarMensagemProcessada: jest.fn(async () => false),
  startDedupCleanup: jest.fn(),
}));
jest.mock("../src/whatsapp/lid-map", () => ({
  setLidMapping: jest.fn(),
  carregarLidMap: jest.fn(async () => {}),
  resolveLid: jest.fn(() => null),
  resolveJidToLid: jest.fn(),
  resolveSendJid: jest.fn(id => id),
  getProfilePhotoCandidates: jest.fn(id => [id]),
  getLidMapStats: jest.fn(() => ({ lidToJid: 0 })),
}));
jest.mock("../src/services/ai.service", () => ({
  analisarImagemPeca: jest.fn(),
  suportaVisao: jest.fn(() => false),
  transcreverAudio: jest.fn(),
  suportaAudio: jest.fn(() => false),
}));
jest.mock("../src/services/mediaStorage.service", () => ({
  salvarMidiaRecebida: jest.fn(),
  MEDIA_DIR: "/tmp/media-teste",
  resolverCaminhoMidia: jest.fn(p => p),
}));
jest.mock("../src/services/ticket.service", () => ({
  reopenTicketIfClosed: jest.fn(async () => false),
}));
jest.mock("../src/services/humanMode.service", () => ({
  estaAtivo: jest.fn(() => false),
}));
jest.mock("qrcode-terminal", () => ({ generate: jest.fn() }));
jest.mock("@whiskeysockets/baileys", () => ({
  __esModule: true,
  default: jest.fn(),
  // 2026-10-14: faltava aqui — src/config/whatsapp.js usa
  // makeCacheableSignalKeyStore(state.keys, ...) de verdade; sem isso no
  // mock, a chamada estourava "makeCacheableSignalKeyStore is not a
  // function" em toda suite que carrega o modulo (confirmado: mesmo erro
  // nas 7 suites que mockam este modulo).
  makeCacheableSignalKeyStore: jest.fn((keys) => keys),
  useMultiFileAuthState: jest.fn(async () => ({ state: {}, saveCreds: jest.fn() })),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 3000, 0] })),
  downloadMediaMessage: jest.fn(),
}));

const baileys = require("@whiskeysockets/baileys");

const JID = "5579999998888@s.whatsapp.net";

function criarSockFake() {
  const handlers = {};
  const sock = {
    ev: {
      on: (event, handler) => { handlers[event] = handler; },
      removeAllListeners: jest.fn(),
    },
    sendMessage: jest.fn(async () => ({ key: { id: "OUT1", remoteJid: JID, fromMe: true } })),
    onWhatsApp: jest.fn(async (numero) => [{ exists: true, jid: `${numero}@s.whatsapp.net` }]),
    presenceSubscribe: jest.fn(async () => {}),
    sendPresenceUpdate: jest.fn(async () => {}),
  };
  sock.__handlers = handlers;
  return sock;
}

const whatsapp = require("../src/config/whatsapp");

describe("config/whatsapp — sendMessage/sendMedia: quoted + tipos novos de mídia", () => {
  let sockAtual;

  beforeEach(async () => {
    jest.clearAllMocks();
    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });
    await whatsapp.connectWhatsApp(jest.fn());
    // Simula conexão estabelecida (ver onConnectionUpdate, connection === "open")
    sockAtual.__handlers["connection.update"]({ connection: "open" });
  });

  test("sendMessage sem quotedMessageId manda texto normal, sem 'quoted'", async () => {
    await whatsapp.sendMessage(JID, "Olá!");
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(JID, { text: "Olá!" }, undefined);
  });

  test("sendMessage com quotedMessageId monta o objeto 'quoted' reduzido (key + message.conversation)", async () => {
    await whatsapp.sendMessage(JID, "Resposta", {
      quotedMessageId: "MSG-CLIENTE-1",
      quotedText: "Vocês têm alternador pro Corsa 2010?",
    });

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      { text: "Resposta" },
      {
        quoted: {
          key: { remoteJid: JID, id: "MSG-CLIENTE-1", fromMe: false },
          message: { conversation: "Vocês têm alternador pro Corsa 2010?" },
        },
      }
    );
  });

  test("sendMedia tipo 'video' monta msgContent com a chave 'video' e mimetype/caption corretos", async () => {
    await whatsapp.sendMedia(JID, "/tmp/media-teste/enviada-1.mp4", "Segue o vídeo", "video", {
      mimetype: "video/mp4",
    });

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      { video: { url: "/tmp/media-teste/enviada-1.mp4" }, mimetype: "video/mp4", caption: "Segue o vídeo" },
      undefined
    );
  });

  test("sendMedia tipo 'document' (genérico, não-PDF) usa mimetype/fileName recebidos, não força application/pdf", async () => {
    await whatsapp.sendMedia(JID, "/tmp/media-teste/enviada-2.docx", "", "document", {
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: "orcamento.docx",
    });

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      {
        document: { url: "/tmp/media-teste/enviada-2.docx" },
        mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileName: "orcamento.docx",
        caption: undefined,
      },
      undefined
    );
  });

  test("sendMedia tipo 'pdf' (legado, usado por broadcast.service.js) continua funcionando sem mudança", async () => {
    await whatsapp.sendMedia(JID, "/tmp/media-teste/campanha.pdf", "Catálogo novo", "pdf");

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      {
        document: { url: "/tmp/media-teste/campanha.pdf" },
        mimetype: "application/pdf",
        fileName: "campanha.pdf",
        caption: "Catálogo novo",
      },
      undefined
    );
  });

  test("sendMedia aceita quoted junto com mídia (responder citando uma mensagem, mandando uma foto)", async () => {
    await whatsapp.sendMedia(JID, "/tmp/media-teste/foto.jpg", "", "image", {
      quotedMessageId: "MSG-CLIENTE-2",
      quotedText: "Manda foto da peça",
    });

    const [, , options] = sockAtual.sendMessage.mock.calls[0];
    expect(options).toEqual({
      quoted: {
        key: { remoteJid: JID, id: "MSG-CLIENTE-2", fromMe: false },
        message: { conversation: "Manda foto da peça" },
      },
    });
  });
});
