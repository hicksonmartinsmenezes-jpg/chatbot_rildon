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
  suportaVisao: jest.fn(),
  transcreverAudio: jest.fn(),
  suportaAudio: jest.fn(),
}));
// Ver migration 017 — config/whatsapp.js agora baixa e salva em disco
// QUALQUER mídia recebida (independente de suportaVisao()/suportaAudio()),
// pro painel poder exibir o arquivo. Mockado pra não tocar disco de verdade
// nesses testes; cada teste ajusta o retorno quando precisa checar o
// threading de mediaPath/mediaMimetype/mediaFilename.
jest.mock("../src/services/mediaStorage.service", () => ({
  salvarMidiaRecebida: jest.fn(),
}));
// BUG CORRIGIDO (2026-07-23): o aviso de "mídia não suportada" agora chama
// reopenTicketIfClosed e checa humanMode/bot desligado (ver config/
// whatsapp.js) — precisa mockar pra não tocar banco de verdade e pra poder
// simular os dois estados nos testes abaixo.
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
const { analisarImagemPeca, suportaVisao, transcreverAudio, suportaAudio } = require("../src/services/ai.service");
const { saveHistory } = require("../src/services/history.service");
const { salvarMidiaRecebida } = require("../src/services/mediaStorage.service");
const { reopenTicketIfClosed } = require("../src/services/ticket.service");
const humanMode = require("../src/services/humanMode.service");
const { getBotConfig } = require("../src/services/botConfig.service");
const { emitEvent } = require("../src/services/socket.service");

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

// Áudio enviado pelo menu de ANEXO do WhatsApp (não gravado na hora segurando
// o microfone) — o WhatsApp empacota isso como documentMessage, não
// audioMessage, mesmo sendo um arquivo de áudio de verdade (achado em teste
// ao vivo, 2026-07-20, subindo um .mp3 pelo anexo "Áudio" do WhatsApp Web).
function mensagemAudioComoDocumento({ mimetype = "audio/mpeg" } = {}) {
  return {
    key: { id: "MSG-AUDIO-DOC-1", remoteJid: JID, fromMe: false },
    pushName: "Cliente Teste",
    message: {
      documentMessage: { mimetype, fileName: "audio.mp3" },
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
    salvarMidiaRecebida.mockResolvedValue({
      mediaPath: "MSG-IMG-1-abcd1234.jpg",
      mediaMimetype: "image/jpeg",
      mediaFilename: null,
    });

    processMessage = jest.fn(async () => "Já te ajudo com o orçamento! 😊");
    await whatsapp.connectWhatsApp(processMessage);
  });

  // BUG REAL (achado em teste ao vivo, 2026-07-20 — usuário perguntou
  // "verifique por que arquivos de mídia e áudio não aparecem no meu
  // painel"): o bot baixava a mídia só quando ia analisá-la (visão/áudio),
  // nunca salvava o arquivo em disco — o painel só via o rótulo "[imagem
  // recebida]". Agora salva SEMPRE que há mídia, independente de análise.
  test("mídia é sempre baixada e salva em disco, e mediaPath/mediaMimetype chegam no pipeline de texto (ver migration 017)", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue("motor de partida, aparenta ser de um Fiat Uno");

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(salvarMidiaRecebida).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-imagem"),
      "image/jpeg",
      "MSG-IMG-1",
      expect.objectContaining({ originalFilename: null })
    );
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaPath: "MSG-IMG-1-abcd1234.jpg",
        mediaMimetype: "image/jpeg",
      })
    );
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

  test("suportaVisao() false (provedor ativo sem suporte a imagem, ex: groq) → NÃO analisa, mas ainda baixa/salva a foto pro painel", async () => {
    suportaVisao.mockReturnValue(false);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    // Ver migration 017: baixar/salvar em disco é decisão de STORAGE, agora
    // independente de a IA conseguir analisar a imagem ou não.
    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(salvarMidiaRecebida).toHaveBeenCalled();
    expect(analisarImagemPeca).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada", mediaPath: "MSG-IMG-1-abcd1234.jpg" })
    );
  });

  test("erro ao baixar a mídia (ex: link expirado) → não tenta de novo, cai no aviso padrão, não lança exceção", async () => {
    suportaVisao.mockReturnValue(true);
    baileys.downloadMediaMessage.mockRejectedValueOnce(new Error("media link expirado (410)"));

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    // Download falhou UMA vez (no bloco de storage) — não deve haver um
    // 2º download "escondido" dentro de analisarFotoRecebida mascarando a
    // falha original (ver comentário "!== undefined" em config/whatsapp.js).
    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(salvarMidiaRecebida).not.toHaveBeenCalled();
    expect(analisarImagemPeca).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
  });

  // BUG REAL (achado em teste ao vivo, 2026-07-20): antes, este bloco só
  // rodava dentro do `if (!text)` — foto com legenda tinha `text` não-vazio
  // (a legenda), então a checagem de visão nunca era alcançada. A imagem
  // NUNCA era examinada, só a legenda ia pro pipeline normal. Corrigido: a
  // checagem de imagem roda ANTES do `if (!text)`, cobrindo os dois casos.
  test("foto COM legenda: analisa a imagem e combina legenda + descrição antes de processar", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue("alternador Bosch com conector danificado");

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemImagem({ caption: "quanto custa esse alternador?" })],
      type: "notify",
    });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(analisarImagemPeca).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-imagem").toString("base64"),
      "image/jpeg"
    );

    // O texto passado pro pipeline deve conter TANTO a legenda do cliente
    // QUANTO a descrição da imagem — nenhum dos dois pode ser descartado.
    const chamada = processMessage.mock.calls[0][0];
    expect(chamada.message).toContain("quanto custa esse alternador?");
    expect(chamada.message).toContain("alternador Bosch com conector danificado");
  });

  test("foto COM legenda + análise de visão falha (null): usa só a legenda normalmente, sem cair no aviso de mídia não suportada", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue(null);

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemImagem({ caption: "quanto custa esse alternador?" })],
      type: "notify",
    });

    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "quanto custa esse alternador?" })
    );
    expect(saveHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });

  test("foto COM legenda + suportaVisao() false: legenda vai pro pipeline normal, mas a foto ainda é baixada/salva pro painel", async () => {
    suportaVisao.mockReturnValue(false);

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemImagem({ caption: "quanto custa esse alternador?" })],
      type: "notify",
    });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(salvarMidiaRecebida).toHaveBeenCalled();
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
    salvarMidiaRecebida.mockResolvedValue({
      mediaPath: "MSG-AUDIO-1-efgh5678.ogg",
      mediaMimetype: "audio/ogg; codecs=opus",
      mediaFilename: null,
    });

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

  test("suportaAudio() false (GROQ_API_KEY não configurada) → NÃO transcreve, mas ainda baixa/salva o áudio pro painel", async () => {
    suportaAudio.mockReturnValue(false);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemAudio()], type: "notify" });

    // Ver migration 017: baixar/salvar em disco é decisão de STORAGE, agora
    // independente de a Groq estar configurada ou não.
    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(salvarMidiaRecebida).toHaveBeenCalled();
    expect(transcreverAudio).not.toHaveBeenCalled();
    expect(processMessage).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada", mediaPath: "MSG-AUDIO-1-efgh5678.ogg" })
    );
  });

  test("erro ao baixar a mídia de áudio → não tenta de novo, cai no aviso padrão, não lança exceção", async () => {
    suportaAudio.mockReturnValue(true);
    baileys.downloadMediaMessage.mockRejectedValueOnce(new Error("media link expirado (410)"));

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemAudio()], type: "notify" });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(salvarMidiaRecebida).not.toHaveBeenCalled();
    expect(transcreverAudio).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
  });

  // BUG REAL (achado em teste ao vivo, 2026-07-20): áudio enviado pelo menu
  // de ANEXO do WhatsApp (subindo um arquivo .mp3/.ogg, não gravando na hora)
  // chega como documentMessage — antes disso, getMediaType() classificava
  // isso como "documento" genérico, nunca "áudio", e a transcrição nunca
  // era tentada mesmo com Whisper configurado.
  test("áudio enviado como documento (mimetype audio/*) é transcrito normalmente", async () => {
    suportaAudio.mockReturnValue(true);
    transcreverAudio.mockResolvedValue("preciso de uma bomba de combustível pro meu fiat uno 2016");

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemAudioComoDocumento({ mimetype: "audio/mpeg" })],
      type: "notify",
    });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(transcreverAudio).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-audio"),
      "audio/mpeg"
    );
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "preciso de uma bomba de combustível pro meu fiat uno 2016" })
    );
    expect(saveHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });

  test("documento que NÃO é áudio (mimetype application/pdf) cai no aviso padrão, mas o arquivo ainda é baixado/salvo pro painel", async () => {
    suportaAudio.mockReturnValue(true);
    salvarMidiaRecebida.mockResolvedValue({
      mediaPath: "MSG-AUDIO-DOC-1-ijkl9012.pdf",
      mediaMimetype: "application/pdf",
      mediaFilename: "audio.mp3", // fileName do documentMessage, mesmo mimetype não batendo — cliente às vezes erra a extensão
    });

    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemAudioComoDocumento({ mimetype: "application/pdf" })],
      type: "notify",
    });

    // Documento genérico também é mídia recebida — ver getMediaObject() em
    // message-utils.js, que (ao contrário de getMediaType) não distingue
    // documento-áudio de documento comum pra decidir SE baixa, só o QUE
    // fazer depois de baixado.
    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(salvarMidiaRecebida).toHaveBeenCalled();
    expect(transcreverAudio).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada", message: "[documento recebido]" })
    );
  });
});

// BUG CORRIGIDO (relatado pelo usuário, 2026-07-23): "as mensagens ainda não
// carregam com bot desligado" e "chega com clientes já fechados porém não
// aparece como novo atendimento". Duas causas raiz, ambas em
// config/whatsapp.js: (1) o aviso de mídia não suportada nunca chamava
// reopenTicketIfClosed (só o pipeline de TEXTO, via processMessage, fazia
// isso) — cliente com ticket fechado mandando só uma foto/sticker nunca
// reaparecia em Pendentes; (2) o mesmo aviso nunca checava humanMode nem bot
// desligado, respondendo automaticamente por cima de atendente humano ou com
// o bot desativado no painel.
describe("config/whatsapp — mídia não suportada: reopen de ticket + respeito a humanMode/bot desligado", () => {
  let processMessage, sockAtual;

  function mensagemSticker() {
    return {
      key: { id: "MSG-STICKER-1", remoteJid: JID, fromMe: false },
      pushName: "Cliente Teste",
      message: {
        stickerMessage: { mimetype: "image/webp" },
      },
    };
  }

  // getBotConfigCached() (config/whatsapp.js) guarda o resultado de
  // getBotConfig() por 30s em memória (conn.cachedConfig) — como o módulo
  // config/whatsapp é exigido uma ÚNICA vez no topo deste arquivo (compartilhado
  // por todos os describes), o cache continua "quente" de um teste pro outro
  // dentro da mesma execução rápida da suíte. Sem isso, o teste de "bot
  // desligado" (que muda getBotConfig no meio da suíte) veria o valor antigo
  // em cache. Usa um relógio simulado sempre CRESCENTE (avança 40s a cada
  // teste) pra garantir que todo teste force um refetch — nunca herda o
  // cache do teste anterior, independente da ordem.
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
    baileys.downloadMediaMessage.mockResolvedValue(Buffer.from("bytes-fake-de-sticker"));
    suportaVisao.mockReturnValue(false);
    suportaAudio.mockReturnValue(false);
    salvarMidiaRecebida.mockResolvedValue({
      mediaPath: "MSG-STICKER-1-wxyz0001.webp",
      mediaMimetype: "image/webp",
      mediaFilename: null,
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

  test("mídia sem legenda em geral (ex: imagem) chama reopenTicketIfClosed", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(reopenTicketIfClosed).toHaveBeenCalledWith(JID);
  });

  // PEDIDO DO USUÁRIO (2026-07-27, 2ª parte): sticker é só uma reação — não
  // deve reabrir um ticket fechado (diferente de foto/áudio/vídeo/documento,
  // que continuam reabrindo normalmente, ver teste acima).
  test("STICKER é a única exceção — NÃO chama reopenTicketIfClosed", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemSticker()], type: "notify" });

    expect(reopenTicketIfClosed).not.toHaveBeenCalled();
  });

  test("atendente já assumiu (humanMode ativo) → NÃO envia o aviso automático, mas ainda salva/emite a mídia no histórico", async () => {
    humanMode.estaAtivo.mockReturnValue(true);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemSticker()], type: "notify" });

    expect(sockAtual.sendMessage).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: JID, sector: "humano", response: null, message: "[sticker recebido]" })
    );
  });

  test("bot desligado no painel → NÃO envia o aviso automático, mas ainda salva/emite a mídia no histórico", async () => {
    getBotConfig.mockResolvedValue({ ativo: false });

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemSticker()], type: "notify" });

    expect(sockAtual.sendMessage).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: JID, sector: "bot_desligado", response: null, message: "[sticker recebido]" })
    );
  });

  // PEDIDO DO USUÁRIO (2026-07-27): "o bot não responda stickers, isso
  // resolverá boa parte dos problemas" — sticker é quase sempre uma reação
  // (like, risada), igual emoji solto (ver pareceEncerramentoPosAvaliacao em
  // ticket.service.js). Diferente dos outros tipos de mídia sem legenda
  // (imagem/áudio/vídeo/documento, que continuam recebendo o aviso
  // "não consigo processar arquivos"), sticker NUNCA recebe esse aviso —
  // mesmo com o bot ligado e ninguém tendo assumido — mas ainda é salvo no
  // histórico (sector distinto "sticker_sem_resposta"), pra não sumir do
  // painel.
  test("bot ligado e ninguém assumiu + STICKER → NÃO envia aviso, salva com sector distinto", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemSticker()], type: "notify" });

    expect(sockAtual.sendMessage).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "sticker_sem_resposta", response: null, message: "[sticker recebido]" })
    );
    expect(emitEvent).toHaveBeenCalledWith(
      "nova_mensagem",
      expect.objectContaining({ sector: "sticker_sem_resposta", response: null })
    );
  });

  // Regressão: outros tipos de mídia sem legenda (ex: imagem) continuam
  // recebendo o aviso automático normalmente — só sticker mudou.
  test("bot ligado e ninguém assumiu + IMAGEM sem legenda (caso normal) → continua enviando o aviso automático", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });
});
