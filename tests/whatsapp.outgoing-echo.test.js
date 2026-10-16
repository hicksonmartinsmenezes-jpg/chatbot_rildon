/**
 * PEDIDO DO USUÁRIO (2026-07-27): "mensagens enviadas pelo meu celular com o
 * número do bot não aparecem no chat do painel".
 *
 * Causa raiz: isValidUserMessage() (message-utils.js) descartava TODA
 * mensagem com key.fromMe === true, sem distinguir três origens possíveis:
 *   1. Painel (sendManualMessage/sendMedia) — já salva no histórico ali mesmo.
 *   2. Bot (enviarComRetry) — já salva no histórico dentro de processMessage.
 *   3. WhatsApp do CELULAR, direto — nunca salvo em lugar nenhum até agora.
 *
 * Fix: sendMessage/sendMedia/enviarComRetry agora registram o id da mensagem
 * enviada em marcarMensagemProcessada() NO MOMENTO DO ENVIO — então o eco
 * fromMe de (1) e (2) é descartado pelo dedup de topo de onMessagesUpsert,
 * ANTES de chegar em isOutgoingEcho(). Um fromMe que sobrevive até lá só
 * pode ser (3) — tratado por handleOutgoingFromPhone(), que salva no
 * histórico (sector "manual", igual sendManualMessage), emite pro painel e
 * pausa o bot pro cliente (humanMode.ativar).
 */
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn(async () => ({ ativo: true })),
  resolverBotOffEfetivo: jest.fn(({ ativoFalse }) => ativoFalse),
}));
jest.mock("../src/services/history.service", () => ({ saveHistory: jest.fn(async () => ({})) }));
jest.mock("../src/whatsapp/contacts", () => ({
  autoRegisterContact: jest.fn(async () => {}),
  contatoTemTagFuncionario: jest.fn(async () => false),
  buscarNomeContatoReal: jest.fn(async () => ""),
}));

let dedupRegistry;
jest.mock("../src/whatsapp/dedup", () => {
  const registry = new Set();
  return {
    __registry: registry,
    isDuplicateContent: jest.fn(() => false),
    marcarMensagemProcessada: jest.fn(async (id) => {
      if (!id) return false;
      if (registry.has(id)) return true;
      registry.add(id);
      return false;
    }),
    startDedupCleanup: jest.fn(),
  };
});
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
}));
jest.mock("../src/services/ticket.service", () => ({
  reopenTicketIfClosed: jest.fn(async () => false),
}));
jest.mock("../src/services/humanMode.service", () => ({
  estaAtivo: jest.fn(() => false),
  ativar: jest.fn(),
}));
jest.mock("../src/repositories/user.repository", () => ({
  findByUsername: jest.fn(async () => ({ id: "u-rafael", nome: "Rafael", usuario: "atendente04", ativo: true })),
}));
jest.mock("../src/controllers/message.controller", () => ({
  ensureTicketForManualReply: jest.fn(async () => {}),
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
const { saveHistory } = require("../src/services/history.service");
const { emitEvent } = require("../src/services/socket.service");
const humanMode = require("../src/services/humanMode.service");
const { resolveLid, setLidMapping } = require("../src/whatsapp/lid-map");
const { salvarMidiaRecebida } = require("../src/services/mediaStorage.service");
const dedup = require("../src/whatsapp/dedup");
const userRepository = require("../src/repositories/user.repository");
const { ensureTicketForManualReply } = require("../src/controllers/message.controller");

const JID = "5579999998888@s.whatsapp.net";

function criarSockFake() {
  const handlers = {};
  const sock = {
    ev: {
      on: (event, handler) => { handlers[event] = handler; },
      removeAllListeners: jest.fn(),
    },
    sendMessage: jest.fn(async () => ({ key: { id: "OUT-" + Math.random().toString(36).slice(2), remoteJid: JID, fromMe: true } })),
    presenceSubscribe: jest.fn(async () => {}),
    sendPresenceUpdate: jest.fn(async () => {}),
  };
  sock.__handlers = handlers;
  return sock;
}

function mensagemEnviadaPeloCelular({ id = "PHONE-MSG-1", jid = JID, texto = "Bom dia! Já te mando o orçamento." } = {}) {
  return {
    key: { id, remoteJid: jid, fromMe: true },
    message: { conversation: texto },
  };
}

function mensagemImagemDoCelular({ id = "PHONE-IMG-1", jid = JID, caption = "" } = {}) {
  return {
    key: { id, remoteJid: jid, fromMe: true },
    message: { imageMessage: { mimetype: "image/jpeg", caption } },
  };
}

const whatsapp = require("../src/config/whatsapp");

describe("config/whatsapp — mensagem enviada pelo CELULAR (eco fromMe não reconhecido)", () => {
  let processMessage, sockAtual;

  beforeEach(async () => {
    jest.clearAllMocks();
    dedup.__registry.clear();
    resolveLid.mockReturnValue(null);

    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });

    processMessage = jest.fn(async () => "resposta do bot");
    await whatsapp.connectWhatsApp(processMessage);
  });

  test("mensagem fromMe com id NUNCA visto (não veio do painel nem do bot) → salva no histórico como 'manual' e pausa o bot", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemEnviadaPeloCelular()],
      type: "notify",
    });

    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: JID,
        message: null,
        response: "Bom dia! Já te mando o orçamento.",
        sector: "manual",
        messageId: "PHONE-MSG-1",
        status: "sent",
      })
    );
    expect(emitEvent).toHaveBeenCalledWith(
      "nova_mensagem",
      expect.objectContaining({ userId: JID, sector: "manual", response: "Bom dia! Já te mando o orçamento." })
    );
    expect(humanMode.ativar).toHaveBeenCalledWith(JID, expect.objectContaining({ agentName: "Celular" }));
    // Não deve cair no pipeline normal do bot (não é mensagem de cliente).
    expect(processMessage).not.toHaveBeenCalled();
  });

  test("resposta pelo celular → atendimento aceito em nome do atendente fixo (Rafael)", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemEnviadaPeloCelular({ id: "PHONE-ACEITE-1" })],
      type: "notify",
    });

    expect(userRepository.findByUsername).toHaveBeenCalledWith("atendente04");
    expect(ensureTicketForManualReply).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ id: "u-rafael", nome: "Rafael" }),
      ""
    );
  });

  test("atendente fixo inexistente/inativo → não quebra, só não aceita o atendimento", async () => {
    userRepository.findByUsername.mockResolvedValueOnce(null);

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemEnviadaPeloCelular({ id: "PHONE-ACEITE-2" })],
      type: "notify",
    });

    expect(saveHistory).toHaveBeenCalled();
    expect(ensureTicketForManualReply).not.toHaveBeenCalled();
  });

  test("mensagem fromMe cujo id JÁ foi registrado no envio (painel/bot) → NÃO trata como celular, não duplica histórico", async () => {
    // Simula o registro feito por sendMessage()/enviarComRetry() no momento
    // do envio, ANTES do eco chegar via messages.upsert.
    await dedup.marcarMensagemProcessada("JA-ENVIADO-1");

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemEnviadaPeloCelular({ id: "JA-ENVIADO-1" })],
      type: "notify",
    });

    expect(saveHistory).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
    expect(humanMode.ativar).not.toHaveBeenCalled();
  });

  test("mensagem fromMe com @lid resolvido → salva sob o userId resolvido (número), não o @lid bruto", async () => {
    const lidJid = "123456789@lid";
    resolveLid.mockReturnValue(JID);

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemEnviadaPeloCelular({ id: "PHONE-LID-1", jid: lidJid })],
      type: "notify",
    });

    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: JID, messageId: "PHONE-LID-1" })
    );
  });

  test("mensagem fromMe em grupo (@g.us) → ignorada por completo, não trata como celular", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemEnviadaPeloCelular({ id: "GRUPO-1", jid: "123456-group@g.us" })],
      type: "notify",
    });

    expect(saveHistory).not.toHaveBeenCalled();
    expect(humanMode.ativar).not.toHaveBeenCalled();
  });

  test("mensagem fromMe sem texto e sem mídia (ex: recibo/reação) → não salva nada", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [{ key: { id: "VAZIO-1", remoteJid: JID, fromMe: true }, message: {} }],
      type: "notify",
    });

    expect(saveHistory).not.toHaveBeenCalled();
  });

  test("imagem enviada pelo celular (sem legenda) → baixa, salva mídia e histórico com '[arquivo enviado]'", async () => {
    baileys.downloadMediaMessage.mockResolvedValue(Buffer.from("foto-tirada-no-celular"));
    salvarMidiaRecebida.mockResolvedValue({
      mediaPath: "PHONE-IMG-1-abc.jpg",
      mediaMimetype: "image/jpeg",
      mediaFilename: null,
    });

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemImagemDoCelular()],
      type: "notify",
    });

    expect(salvarMidiaRecebida).toHaveBeenCalledWith(
      Buffer.from("foto-tirada-no-celular"),
      "image/jpeg",
      "PHONE-IMG-1",
      expect.objectContaining({ originalFilename: null })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        response: "[arquivo enviado]",
        mediaPath: "PHONE-IMG-1-abc.jpg",
        mediaMimetype: "image/jpeg",
        sector: "manual",
      })
    );
  });
});

describe("config/whatsapp — sendMessage/sendMedia/enviarComRetry registram o id no envio", () => {
  let sockAtual;

  beforeEach(async () => {
    jest.clearAllMocks();
    dedup.__registry.clear();
    resolveLid.mockReturnValue(null);

    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });

    await whatsapp.connectWhatsApp(jest.fn(async () => "ok"));
  });

  test("sendMessage() chama marcarMensagemProcessada com o id retornado pelo Baileys", async () => {
    sockAtual.__handlers["connection.update"]({ connection: "open" });
    sockAtual.onWhatsApp = jest.fn(async () => [{ exists: true, jid: JID }]);
    sockAtual.sendMessage.mockResolvedValueOnce({ key: { id: "SENT-VIA-PAINEL-1", remoteJid: JID, fromMe: true } });

    await whatsapp.sendMessage(JID, "Olá, aqui é o Rafael");

    expect(dedup.marcarMensagemProcessada).toHaveBeenCalledWith("SENT-VIA-PAINEL-1");
  });
});
