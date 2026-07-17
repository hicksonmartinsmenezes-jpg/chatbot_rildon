/**
 * Teste de integração do handler messages.upsert (config/whatsapp.js) para
 * mídia sem legenda — foto (visão) e, mais adiante, áudio (transcrição).
 *
 * Por que este arquivo existe: os testes anteriores da feature de visão
 * (ai.service.test.js) cobriam só analisarImagemPeca() ISOLADA — nunca a
 * função analisarFotoRecebida()/o wiring dentro de onMessagesUpsert em si.
 * Isso escondeu um bug real: analisarFotoRecebida() chamava
 * unwrapMessage(msg) em vez de unwrapMessage(msg.message), então
 * `imageMessage` era sempre undefined e a análise de visão NUNCA rodava de
 * verdade em produção, mesmo com o provedor certo configurado — toda foto
 * caía direto no aviso antigo de "ainda não consigo processar arquivos".
 * Este arquivo simula o evento messages.upsert do Baileys de ponta a ponta
 * (com downloadMediaMessage e ai.service mockados) para pegar esse tipo de
 * bug de wiring, que um teste só da função isolada não pega.
 */
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn(async () => ({ ativo: true })),
}));
jest.mock("../src/services/history.service", () => ({ saveHistory: jest.fn(async () => {}) }));
jest.mock("../src/whatsapp/contacts", () => ({ autoRegisterContact: jest.fn(async () => {}) }));
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
  suportaVisao: jest.fn(),
  transcreverAudio: jest.fn(),
  suportaAudio: jest.fn(),
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
const { analisarImagemPeca, suportaVisao, transcreverAudio, suportaAudio } = require("../src/services/ai.service");
const { saveHistory } = require("../src/services/history.service");

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

function mensagemImagem({ caption = "" } = {}) {
  return {
    key: { id: "MSG-IMG-1", remoteJid: JID, fromMe: false },
    pushName: "Cliente Teste",
    message: {
      imageMessage: { mimetype: "image/jpeg", caption },
    },
  };
}

function mensagemAudio() {
  return {
    key: { id: "MSG-AUDIO-1", remoteJid: JID, fromMe: false },
    pushName: "Cliente Teste",
    message: {
      audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true },
    },
  };
}

const whatsapp = require("../src/config/whatsapp");

describe("config/whatsapp — messages.upsert com foto sem legenda (visão)", () => {
  let processMessage, sockAtual;

  beforeEach(async () => {
    jest.clearAllMocks();

    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });
    baileys.downloadMediaMessage.mockResolvedValue(Buffer.from("bytes-fake-de-imagem"));
    suportaVisao.mockReturnValue(false);
    analisarImagemPeca.mockResolvedValue(null);
    suportaAudio.mockReturnValue(false);
    transcreverAudio.mockResolvedValue(null);

    processMessage = jest.fn(async () => "Já te ajudo com o orçamento! 😊");
    await whatsapp.connectWhatsApp(processMessage);
  });

  test("suportaVisao() true + descrição válida → baixa mídia, processa a descrição como texto e envia a resposta do bot", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue("motor de partida, aparenta ser de um Fiat Uno");

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(analisarImagemPeca).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-imagem").toString("base64"),
      "image/jpeg"
    );

    // A descrição da IA deve ter sido processada pelo MESMO pipeline de texto
    // (não deve virar "[imagem recebida]" nem cair no aviso padrão).
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "motor de partida, aparenta ser de um Fiat Uno" })
    );

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(JID, { text: "Já te ajudo com o orçamento! 😊" });

    // Não deve ter caído no fallback de mídia não suportada.
    expect(saveHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });

  test("suportaVisao() true mas análise devolve null (não é peça, provedor falhou) → cai no aviso padrão de mídia", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue(null);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    // processMessage (pipeline de texto) NÃO deve ter sido chamado nesse caso.
    expect(processMessage).not.toHaveBeenCalled();

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });

  test("suportaVisao() false (provedor ativo sem suporte a imagem, ex: groq) → nem tenta baixar/analisar, vai direto pro aviso padrão", async () => {
    suportaVisao.mockReturnValue(false);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(baileys.downloadMediaMessage).not.toHaveBeenCalled();
    expect(analisarImagemPeca).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
  });

  test("erro ao baixar a mídia (ex: link expirado) → analisarFotoRecebida devolve null, cai no aviso padrão, não lança exceção", async () => {
    suportaVisao.mockReturnValue(true);
    baileys.downloadMediaMessage.mockRejectedValueOnce(new Error("media link expirado (410)"));

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(analisarImagemPeca).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
  });

  test("foto COM legenda não entra no caminho de visão (texto já presente vai pelo fluxo normal)", async () => {
    suportaVisao.mockReturnValue(true);

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemImagem({ caption: "quanto custa esse alternador?" })],
      type: "notify",
    });

    expect(baileys.downloadMediaMessage).not.toHaveBeenCalled();
    expect(analisarImagemPeca).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "quanto custa esse alternador?" })
    );
  });
});

describe("config/whatsapp — messages.upsert com nota de voz (transcrição)", () => {
  let processMessage, sockAtual;

  beforeEach(async () => {
    jest.clearAllMocks();

    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });
    baileys.downloadMediaMessage.mockResolvedValue(Buffer.from("bytes-fake-de-audio"));
    suportaVisao.mockReturnValue(false);
    analisarImagemPeca.mockResolvedValue(null);
    suportaAudio.mockReturnValue(false);
    transcreverAudio.mockResolvedValue(null);

    processMessage = jest.fn(async () => "Perfeito, já te ajudo com o motor de partida! 😊");
    await whatsapp.connectWhatsApp(processMessage);
  });

  test("suportaAudio() true + transcrição válida → baixa mídia, processa a transcrição como texto e envia a resposta do bot", async () => {
    suportaAudio.mockReturnValue(true);
    transcreverAudio.mockResolvedValue("preciso de um motor de partida pro meu fiat uno 2015");

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemAudio()], type: "notify" });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(transcreverAudio).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-audio"),
      "audio/ogg; codecs=opus"
    );

    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "preciso de um motor de partida pro meu fiat uno 2015" })
    );
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      { text: "Perfeito, já te ajudo com o motor de partida! 😊" }
    );
    expect(saveHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });

  test("suportaAudio() true mas transcrição devolve null (sem chave, erro, áudio sem fala) → cai no aviso padrão de mídia", async () => {
    suportaAudio.mockReturnValue(true);
    transcreverAudio.mockResolvedValue(null);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemAudio()], type: "notify" });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada", message: "[áudio recebido]" })
    );
  });

  test("suportaAudio() false (GROQ_API_KEY não configurada) → nem tenta baixar/transcrever, vai direto pro aviso padrão", async () => {
    suportaAudio.mockReturnValue(false);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemAudio()], type: "notify" });

    expect(baileys.downloadMediaMessage).not.toHaveBeenCalled();
    expect(transcreverAudio).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
  });

  test("erro ao baixar a mídia de áudio → cai no aviso padrão, não lança exceção", async () => {
    suportaAudio.mockReturnValue(true);
    baileys.downloadMediaMessage.mockRejectedValueOnce(new Error("media link expirado (410)"));

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemAudio()], type: "notify" });

    expect(transcreverAudio).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
  });
});
