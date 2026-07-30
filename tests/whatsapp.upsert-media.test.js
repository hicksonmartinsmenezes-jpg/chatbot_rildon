/**
 * Teste de integração do handler messages.upsert (config/whatsapp.js) para
 * mídia — foto e, mais adiante, áudio (transcrição).
 *
 * REESCRITO (2026-07-29, pedido do usuário): a feature de foto parou de usar
 * IA de visão pra interpretar a imagem (custo/confiabilidade) — ver bloco de
 * tratamento de imageMessage em config/whatsapp.js.
 *   • Foto COM legenda → processa só a legenda como texto normal (mesmo
 *     pipeline de sempre), nunca "vê" a imagem.
 *   • Foto SEM legenda → espera 3s e pergunta se o cliente quer registrar um
 *     orçamento (reaproveita o intercept "aguardandoConfirmacaoOrcamento" já
 *     usado por main.flow.js).
 *
 * REATIVAÇÃO PARCIAL DA VISÃO (2026-07-29, mesmo dia, pedido do usuário): a
 * pergunta de orçamento agora usa a IA de visão (analisarImagemPeca) quando
 * disponível — se ela reconhecer a peça com confiança (foto de
 * catálogo/produto), a mensagem cita a peça; se não reconhecer (ou a IA
 * julgar que parece foto de celular de peça física real — ver PASSO 2 do
 * PROMPT_VISAO em ai.service.js), cai na pergunta genérica de sempre. A
 * chamada de visão só acontece quando o bot vai mesmo responder (nunca com
 * bot desligado/humano assumido) — ver testes abaixo.
 */
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/session.service", () => ({
  updateSession: jest.fn().mockResolvedValue(undefined),
}));
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
const { updateSession } = require("../src/services/session.service");

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

// getBotConfigCached() (config/whatsapp.js) guarda o resultado por 30s em
// memória de módulo (conn.cachedConfig/conn.lastConfigCheck), e o módulo
// config/whatsapp é exigido UMA ÚNICA VEZ, compartilhado por TODOS os
// describes deste arquivo — então esse cache sobrevive entre testes E entre
// describes diferentes. Por isso o "relógio falso" usado pra estourar esse
// cache (jest.spyOn(Date, "now")) precisa ser um ÚNICO contador CRESCENTE
// GLOBAL do arquivo inteiro, não um `let fakeNow` local por describe: dois
// contadores locais começam quase no mesmo Date.now() real (os corpos de
// describe() rodam de forma síncrona, um logo após o outro, quando o Jest
// carrega o arquivo) e cada um cresce independente — então o describe que
// roda DEPOIS pode ter um fakeNow MENOR que o lastConfigCheck deixado pelo
// describe anterior, fazendo `now - lastConfigCheck` dar negativo (portanto
// "< 30000") e o cache ser (erradamente) considerado fresco. Achado em teste
// real (2026-07-29): o describe de "mídia não suportada" lia a config
// antiga (ativo: true) cacheada pelo describe de "foto", mesmo mockando
// getBotConfig com { ativo: false }.
let __fakeNowGlobal = Date.now();
function avancarFakeNow() {
  __fakeNowGlobal += 40_000;
  return __fakeNowGlobal;
}

describe("config/whatsapp — messages.upsert com foto", () => {
  let processMessage, sockAtual;
  let nowSpy;

  beforeEach(async () => {
    jest.clearAllMocks();
    const fakeNow = avancarFakeNow();
    nowSpy = jest.spyOn(Date, "now").mockImplementation(() => fakeNow);

    baileys.default.mockImplementation(() => {
      sockAtual = criarSockFake();
      return sockAtual;
    });
    baileys.downloadMediaMessage.mockResolvedValue(Buffer.from("bytes-fake-de-imagem"));
    getBotConfig.mockResolvedValue({ ativo: true });
    suportaAudio.mockReturnValue(false);
    transcreverAudio.mockResolvedValue(null);
    // Padrão: sem visão configurada (mesmo comportamento de antes da
    // reativação parcial) — testes específicos abaixo ligam suportaVisao().
    suportaVisao.mockReturnValue(false);
    analisarImagemPeca.mockResolvedValue(null);
    humanMode.estaAtivo.mockReturnValue(false);
    reopenTicketIfClosed.mockResolvedValue(false);
    salvarMidiaRecebida.mockResolvedValue({
      mediaPath: "MSG-IMG-1-abcd1234.jpg",
      mediaMimetype: "image/jpeg",
      mediaFilename: null,
    });

    processMessage = jest.fn(async () => "Já te ajudo com o orçamento! 😊");
    await whatsapp.connectWhatsApp(processMessage);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  // BUG REAL (achado em teste ao vivo, 2026-07-20 — usuário perguntou
  // "verifique por que arquivos de mídia e áudio não aparecem no meu
  // painel"): o bot baixava a mídia só quando ia analisá-la, nunca salvava o
  // arquivo em disco — o painel só via o rótulo "[imagem recebida]". Agora
  // salva SEMPRE que há mídia, independente do que acontece depois.
  test("mídia é sempre baixada e salva em disco (ver migration 017)", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(salvarMidiaRecebida).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-imagem"),
      "image/jpeg",
      "MSG-IMG-1",
      expect.objectContaining({ originalFilename: null })
    );
  }, 10000);

  // PEDIDO DO USUÁRIO (2026-07-29): foto SEM legenda não tenta adivinhar o
  // que é (sem IA de visão) — espera 3s e pergunta se o cliente quer
  // registrar um orçamento, deixando a sessão marcada pra reconhecer um
  // "sim" logo em seguida (mesmo intercept usado em main.flow.js). Sem fake
  // timers neste describe (ver comentário acima do fakeNow) — os 3s passam
  // em tempo real aqui, por isso o timeout do teste é aumentado.
  test("foto SEM legenda: espera 3s, pergunta se quer orçamento e marca a sessão pra reconhecer a confirmação", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("Deseja que eu já registre um orçamento") })
    );
    expect(updateSession).toHaveBeenCalledWith(JID, { aguardandoConfirmacaoOrcamento: true });
    // Não deve ter ido pro pipeline de texto/IA — pergunta é 100% estática.
    expect(processMessage).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "foto_sem_legenda_aguardando_confirmacao", message: "[imagem recebida]" })
    );
  }, 10000);

  // PEDIDO DO USUÁRIO (2026-07-29, reativação parcial da visão): quando
  // analisarImagemPeca reconhece a peça (foto de catálogo/produto,
  // confiável), a pergunta cita a peça em vez do texto genérico.
  test("foto SEM legenda + visão reconhece a peça: menciona a peça na pergunta de orçamento", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue("pastilha de freio dianteira");

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(analisarImagemPeca).toHaveBeenCalledWith(
      Buffer.from("bytes-fake-de-imagem").toString("base64"),
      "image/jpeg"
    );
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("Vi que é *pastilha de freio dianteira*") })
    );
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("Deseja que eu já registre um orçamento") })
    );
    expect(updateSession).toHaveBeenCalledWith(JID, { aguardandoConfirmacaoOrcamento: true });
  }, 10000);

  // Peça real de celular/incerta → analisarImagemPeca (PASSO 2 do prompt)
  // devolve null; cai na pergunta genérica de sempre.
  test("foto SEM legenda + visão disponível mas não reconhece (foto incerta/de celular): pergunta genérica", async () => {
    suportaVisao.mockReturnValue(true);
    analisarImagemPeca.mockResolvedValue(null);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(analisarImagemPeca).toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("📷 Recebi sua foto!") })
    );
  }, 10000);

  // Economia: não chama IA de visão quando nem vai responder de qualquer
  // forma (bot desligado ou humano assumiu) — pedido do usuário.
  test("foto SEM legenda + bot desligado: NÃO chama a IA de visão (economia)", async () => {
    getBotConfig.mockResolvedValue({ ativo: false });
    suportaVisao.mockReturnValue(true);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(analisarImagemPeca).not.toHaveBeenCalled();
  });

  test("foto SEM legenda + bot desligado: não pergunta nada, salva histórico como bot_desligado", async () => {
    getBotConfig.mockResolvedValue({ ativo: false });

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(sockAtual.sendMessage).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "bot_desligado", response: null })
    );
  });

  test("foto SEM legenda + humano já assumiu a conversa: não pergunta nada, salva histórico como humano", async () => {
    humanMode.estaAtivo.mockReturnValue(true);

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(sockAtual.sendMessage).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "humano", response: null })
    );
  });

  test("foto SEM legenda reabre ticket fechado, igual ao aviso de mídia não suportada", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(reopenTicketIfClosed).toHaveBeenCalledWith(JID);
  }, 10000);

  // PEDIDO DO USUÁRIO: foto COM legenda processa só a legenda, como texto
  // normal — nunca tenta "ver" a imagem.
  test("foto COM legenda: processa só a legenda, sem qualquer tentativa de analisar a imagem", async () => {
    await sockAtual.__handlers["messages.upsert"]({
      messages: [mensagemImagem({ caption: "quanto custa esse alternador?" })],
      type: "notify",
    });

    expect(baileys.downloadMediaMessage).toHaveBeenCalledTimes(1); // só o download pro storage
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: "quanto custa esse alternador?" })
    );
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(JID, { text: "Já te ajudo com o orçamento! 😊" });
    expect(saveHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
    // Não deve esperar 3s nem perguntar sobre orçamento — a legenda já é
    // processada de imediato pelo pipeline normal.
    expect(updateSession).not.toHaveBeenCalled();
  });

  test("erro ao baixar a mídia (ex: link expirado) → segue pro fluxo de foto sem legenda, não lança exceção", async () => {
    baileys.downloadMediaMessage.mockRejectedValueOnce(new Error("media link expirado (410)"));

    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(salvarMidiaRecebida).not.toHaveBeenCalled();
    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("Deseja que eu já registre um orçamento") })
    );
  }, 10000);
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

  // Vídeo sem legenda continua caindo no aviso genérico de "mídia não
  // suportada" (só imagem e sticker têm tratamento próprio — ver describe
  // "com foto" mais acima e os testes de STICKER abaixo).
  function mensagemVideo() {
    return {
      key: { id: "MSG-VIDEO-1", remoteJid: JID, fromMe: false },
      pushName: "Cliente Teste",
      message: {
        videoMessage: { mimetype: "video/mp4" },
      },
    };
  }

  // getBotConfigCached() (config/whatsapp.js) guarda o resultado de
  // getBotConfig() por 30s em memória (conn.cachedConfig) — como o módulo
  // config/whatsapp é exigido uma ÚNICA vez no topo deste arquivo (compartilhado
  // por todos os describes), o cache continua "quente" de um teste pro outro
  // dentro da mesma execução rápida da suíte, e também entre ESTE describe e o
  // de "com foto" acima. Usa o contador GLOBAL do arquivo (avancarFakeNow(),
  // ver comentário logo acima do require de whatsapp) em vez de um `let
  // fakeNow` local — ver esse comentário pra entender por que um contador
  // local por describe não é suficiente.
  let nowSpy;

  beforeEach(async () => {
    jest.clearAllMocks();
    const fakeNow = avancarFakeNow();
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

  // Imagem sem legenda passa pelo caminho novo e determinístico (espera 3s
  // reais — sem fake timers aqui, ver comentário no describe "com foto" mais
  // acima), mas continua chamando reopenTicketIfClosed normalmente.
  test("mídia sem legenda em geral (ex: imagem) chama reopenTicketIfClosed", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemImagem()], type: "notify" });

    expect(reopenTicketIfClosed).toHaveBeenCalledWith(JID);
  }, 10000);

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

  // Regressão: outros tipos de mídia sem legenda (ex: vídeo) continuam
  // recebendo o aviso automático genérico normalmente — só sticker E imagem
  // saíram desse caminho (imagem ganhou tratamento próprio, sem IA de visão —
  // ver describe "com foto" mais acima; sticker nunca recebe aviso nenhum).
  test("bot ligado e ninguém assumiu + VÍDEO sem legenda (caso normal) → continua enviando o aviso automático", async () => {
    await sockAtual.__handlers["messages.upsert"]({ messages: [mensagemVideo()], type: "notify" });

    expect(sockAtual.sendMessage).toHaveBeenCalledWith(
      JID,
      expect.objectContaining({ text: expect.stringContaining("ainda não consigo processar arquivos") })
    );
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ sector: "midia_nao_suportada" })
    );
  });
});
