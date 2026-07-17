/**
 * Testes de src/whatsapp/message-utils.js.
 *
 * Achado no Raio-X geral (RAIO_X_GERAL_V16.md): este arquivo decide o TIPO
 * de toda mensagem recebida do WhatsApp (texto, imagem, áudio, vídeo,
 * sticker, documento) e extrai o texto — é o ponto de entrada de tudo que
 * o bot processa, mas tinha 2% de cobertura antes deste arquivo. A sessão
 * de testes manuais ao vivo (foto/áudio/vídeo, com e sem legenda) validou
 * o comportamento na prática; este arquivo fixa isso em teste automatizado.
 */
const {
  unwrapMessage,
  getTextMessage,
  getMediaType,
  isValidUserMessage,
  parseMessageStatus,
} = require("../src/whatsapp/message-utils");

describe("message-utils — unwrapMessage", () => {
  test("mensagem nula/indefinida → null", () => {
    expect(unwrapMessage(null)).toBeNull();
    expect(unwrapMessage(undefined)).toBeNull();
  });

  test("mensagem sem wrapper nenhum → retorna como está", () => {
    const msg = { conversation: "oi" };
    expect(unwrapMessage(msg)).toBe(msg);
  });

  test("desembrulha ephemeralMessage", () => {
    const interno = { conversation: "oi" };
    expect(unwrapMessage({ ephemeralMessage: { message: interno } })).toBe(interno);
  });

  test("desembrulha viewOnceMessage", () => {
    const interno = { imageMessage: {} };
    expect(unwrapMessage({ viewOnceMessage: { message: interno } })).toBe(interno);
  });

  test("desembrulha viewOnceMessageV2", () => {
    const interno = { imageMessage: {} };
    expect(unwrapMessage({ viewOnceMessageV2: { message: interno } })).toBe(interno);
  });

  test("desembrulha documentWithCaptionMessage", () => {
    const interno = { documentMessage: {} };
    expect(unwrapMessage({ documentWithCaptionMessage: { message: interno } })).toBe(interno);
  });

  test("desembrulha wrappers aninhados (ephemeral dentro de viewOnce)", () => {
    const interno = { conversation: "oi" };
    const msg = { viewOnceMessage: { message: { ephemeralMessage: { message: interno } } } };
    expect(unwrapMessage(msg)).toBe(interno);
  });
});

describe("message-utils — getTextMessage", () => {
  function wrap(message) {
    return { message };
  }

  test("conversation simples", () => {
    expect(getTextMessage(wrap({ conversation: "oi, tudo bem?" }))).toBe("oi, tudo bem?");
  });

  test("extendedTextMessage.text", () => {
    expect(getTextMessage(wrap({ extendedTextMessage: { text: "mensagem com formatação" } }))).toBe(
      "mensagem com formatação"
    );
  });

  test("legenda de imagem (imageMessage.caption)", () => {
    expect(getTextMessage(wrap({ imageMessage: { caption: "essa é a peça" } }))).toBe("essa é a peça");
  });

  test("legenda de vídeo (videoMessage.caption)", () => {
    expect(getTextMessage(wrap({ videoMessage: { caption: "vídeo do problema" } }))).toBe("vídeo do problema");
  });

  test("resposta de botão (buttonsResponseMessage.selectedButtonId)", () => {
    expect(getTextMessage(wrap({ buttonsResponseMessage: { selectedButtonId: "opcao_1" } }))).toBe("opcao_1");
  });

  test("resposta de lista (listResponseMessage.singleSelectReply.selectedRowId)", () => {
    expect(
      getTextMessage(wrap({ listResponseMessage: { singleSelectReply: { selectedRowId: "item_2" } } }))
    ).toBe("item_2");
  });

  test("mensagem sem nenhum campo de texto reconhecido → string vazia", () => {
    expect(getTextMessage(wrap({ audioMessage: {} }))).toBe("");
  });

  test("mensagem totalmente vazia → string vazia (não quebra)", () => {
    expect(getTextMessage({ message: null })).toBe("");
  });

  test("extrai texto de dentro de um wrapper (ephemeralMessage)", () => {
    const msg = { message: { ephemeralMessage: { message: { conversation: "oi" } } } };
    expect(getTextMessage(msg)).toBe("oi");
  });
});

describe("message-utils — getMediaType", () => {
  function wrap(message) {
    return { message };
  }

  test("sem mensagem → null", () => {
    expect(getMediaType({ message: null })).toBeNull();
  });

  test("áudio", () => {
    expect(getMediaType(wrap({ audioMessage: {} }))).toBe("áudio");
  });

  test("sticker", () => {
    expect(getMediaType(wrap({ stickerMessage: {} }))).toBe("sticker");
  });

  test("documento", () => {
    expect(getMediaType(wrap({ documentMessage: {} }))).toBe("documento");
  });

  test("imagem SEM legenda → 'imagem'", () => {
    expect(getMediaType(wrap({ imageMessage: {} }))).toBe("imagem");
  });

  // Comportamento chave testado ao vivo nesta sessão: foto + legenda é
  // tratada como mensagem de TEXTO normal (a legenda vira o pedido do
  // cliente), não como mídia sem suporte — getMediaType deve devolver null
  // pra esse caso, já que getTextMessage já extrai a legenda.
  test("imagem COM legenda → null (tratada como texto, não como mídia)", () => {
    expect(getMediaType(wrap({ imageMessage: { caption: "tem essa peça?" } }))).toBeNull();
  });

  test("vídeo SEM legenda → 'vídeo'", () => {
    expect(getMediaType(wrap({ videoMessage: {} }))).toBe("vídeo");
  });

  test("vídeo COM legenda → null (tratada como texto, não como mídia)", () => {
    expect(getMediaType(wrap({ videoMessage: { caption: "o problema é esse" } }))).toBeNull();
  });

  test("texto puro (conversation) → null", () => {
    expect(getMediaType(wrap({ conversation: "oi" }))).toBeNull();
  });

  test("detecta mídia mesmo dentro de um wrapper (viewOnceMessage)", () => {
    const msg = { message: { viewOnceMessage: { message: { audioMessage: {} } } } };
    expect(getMediaType(msg)).toBe("áudio");
  });
});

describe("message-utils — isValidUserMessage", () => {
  function key(overrides = {}) {
    return { key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, ...overrides } };
  }

  test("type diferente de 'notify' → false", () => {
    expect(isValidUserMessage(key(), "append")).toBe(false);
  });

  test("sem remoteJid → false", () => {
    expect(isValidUserMessage(key({ remoteJid: undefined }), "notify")).toBe(false);
  });

  test("mensagem enviada pelo próprio bot (fromMe) → false", () => {
    expect(isValidUserMessage(key({ fromMe: true }), "notify")).toBe(false);
  });

  test("mensagem de grupo (@g.us) → false", () => {
    expect(isValidUserMessage(key({ remoteJid: "12345-6789@g.us" }), "notify")).toBe(false);
  });

  test("newsletter (@newsletter) → false", () => {
    expect(isValidUserMessage(key({ remoteJid: "123@newsletter" }), "notify")).toBe(false);
  });

  test("status@broadcast → false", () => {
    expect(isValidUserMessage(key({ remoteJid: "status@broadcast" }), "notify")).toBe(false);
  });

  test("qualquer @broadcast → false", () => {
    expect(isValidUserMessage(key({ remoteJid: "123@broadcast" }), "notify")).toBe(false);
  });

  test("cliente normal via @s.whatsapp.net → true", () => {
    expect(isValidUserMessage(key({ remoteJid: "5511999999999@s.whatsapp.net" }), "notify")).toBe(true);
  });

  test("cliente via dispositivo vinculado (@lid) → true", () => {
    expect(isValidUserMessage(key({ remoteJid: "123456789012345@lid" }), "notify")).toBe(true);
  });

  test("sufixo desconhecido → false", () => {
    expect(isValidUserMessage(key({ remoteJid: "123@algumacoisa" }), "notify")).toBe(false);
  });
});

describe("message-utils — parseMessageStatus", () => {
  test("1 → sent", () => {
    expect(parseMessageStatus(1)).toBe("sent");
  });

  test("2 → delivered", () => {
    expect(parseMessageStatus(2)).toBe("delivered");
  });

  test("3 → read", () => {
    expect(parseMessageStatus(3)).toBe("read");
  });

  test("valor desconhecido (0, undefined, outro número) → pending", () => {
    expect(parseMessageStatus(0)).toBe("pending");
    expect(parseMessageStatus(undefined)).toBe("pending");
    expect(parseMessageStatus(99)).toBe("pending");
  });
});
