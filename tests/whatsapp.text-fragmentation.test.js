/**
 * BUG CORRIGIDO (item #4 da análise de conversas em produção): o WhatsApp
 * entrega cada mensagem que o cliente digita como um evento separado de
 * messages.upsert. Antes deste fix, config/whatsapp.js chamava
 * conn.messageHandler (processMessage) IMEDIATAMENTE pra cada uma — cliente
 * mandando o pedido em 3 balões seguidos ("Preciso de um orçamento" /
 * "Alternador" / "Corsa 2010 1.0") fazia o bot processar/responder ao
 * primeiro fragmento como se fosse a mensagem inteira, e os fragmentos
 * seguintes chegavam fora de contexto (ver mensagens.js/vendas.flow.js).
 *
 * Este teste simula 3 eventos messages.upsert em sequência rápida pro MESMO
 * cliente e confirma que viram uma ÚNICA chamada ao messageHandler, com o
 * texto combinado — usando messageFragment.service.js de verdade (com
 * fake timers), não mockado, pra pegar bug de wiring de ponta a ponta.
 */
jest.useFakeTimers();

jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn(async () => ({ ativo: true })),
  resolverBotOffEfetivo: jest.fn(({ ativoFalse, isNumeroTeste = false, isFuncionario = false }) => {
    if (isFuncionario) return true;
    if (ativoFalse && isNumeroTeste) return false;
    return ativoFalse;
  }),
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
  useMultiFileAuthState: jest.fn(async () => ({ state: {}, saveCreds: jest.fn() })),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(async () => ({ version: [2, 3000, 0] })),
  downloadMediaMessage: jest.fn(),
}));

const baileys = require("@whiskeysockets/baileys");
const { getBotConfig } = require("../src/services/botConfig.service");
const humanMode = require("../src/services/humanMode.service");
const { reopenTicketIfClosed } = require("../src/services/ticket.service");

const JID = "5579999998888@s.whatsapp.net";

function criarSockFake() {
  const handlers = {};
  const sock = {
    ev: {
      on: (event, handler) => { handlers[event] = handler; },
      removeAllListeners: jest.fn(),
    },
    sendMessage: jest.fn(async () => ({ key: { id: "OUT1", remoteJid: JID, fromMe: true } })),
    presenceSubscribe: jest.fn(async () => {}),
    sendPresenceUpdate: jest.fn(async () => {}),
  };
  sock.__handlers = handlers;
  return sock;
}

function mensagemTexto(texto, id) {
  return {
    key: { id, remoteJid: JID, fromMe: false },
    pushName: "Cliente Teste",
    message: { conversation: texto },
  };
}

const whatsapp = require("../src/config/whatsapp");

describe("config/whatsapp — fragmentação de mensagens de texto", () => {
  let processMessage, sockAtual;
  let fakeNow = Date.now();
  let nowSpy;

  beforeEach(async () => {
    jest.clearAllMocks();
    fakeNow += 40_000;
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => fakeNow);

    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });
    getBotConfig.mockResolvedValue({ ativo: true });
    humanMode.estaAtivo.mockReturnValue(false);
    reopenTicketIfClosed.mockResolvedValue(false);

    processMessage = jest.fn(async () => "resposta do bot");
    await whatsapp.connectWhatsApp(processMessage);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  test("3 mensagens rápidas do mesmo cliente viram UMA única chamada ao bot, com texto combinado", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemTexto("Preciso de um orçamento", "T1")],
      type: "notify",
    });
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemTexto("Alternador", "T2")],
      type: "notify",
    });
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemTexto("Corsa 2010 1.0", "T3")],
      type: "notify",
    });

    // Ainda dentro da janela de espera — nada processado
    expect(processMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3000);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Preciso de um orçamento\nAlternador\nCorsa 2010 1.0",
        messageId: "T3",
      })
    );
    expect(sockAtual.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("mensagem única continua respondida normalmente, só com a espera da janela", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemTexto("Bom dia", "U1")],
      type: "notify",
    });

    expect(processMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(3000);

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Bom dia", messageId: "U1" })
    );
  });
});
