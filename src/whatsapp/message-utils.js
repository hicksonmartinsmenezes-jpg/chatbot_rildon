function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage) return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage) return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2) return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage) return unwrapMessage(message.documentWithCaptionMessage.message);
  return message;
}

function getTextMessage(msg) {
  const message = unwrapMessage(msg.message);
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.buttonsResponseMessage?.selectedButtonId ||
    message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
  );
}

function getMediaType(msg) {
  const message = unwrapMessage(msg.message);
  if (!message) return null;
  if (message.audioMessage) return "áudio";
  if (message.stickerMessage) return "sticker";
  if (message.documentMessage) {
    // BUG REAL (achado em teste ao vivo, 2026-07-20): áudio enviado pelo
    // menu de ANEXO do WhatsApp (não gravado na hora segurando o
    // microfone) chega como documentMessage em vez de audioMessage —
    // caía direto no fallback genérico de "não consigo processar
    // arquivos" e nunca era transcrito, mesmo com Whisper configurado.
    // Documento com mimetype audio/* é áudio de verdade, só empacotado
    // diferente.
    const mimetype = message.documentMessage.mimetype || "";
    if (mimetype.startsWith("audio/")) return "áudio";
    return "documento";
  }
  if (message.imageMessage && !message.imageMessage.caption) return "imagem";
  if (message.videoMessage && !message.videoMessage.caption) return "vídeo";
  return null;
}

// Diferente de getMediaType() (que devolve null pra imagem/vídeo COM
// legenda, de propósito — pro ROTEAMENTO do bot, legenda vira mensagem de
// texto normal), esta função detecta a presença de QUALQUER mídia baixável,
// COM ou SEM legenda. Usada só pra decidir se vale a pena baixar e SALVAR o
// arquivo em disco (painel de atendimento) — decisão de storage, não de
// roteamento de fluxo. Ver mediaStorage.service.js / config/whatsapp.js.
function getMediaObject(msg) {
  const message = unwrapMessage(msg.message);
  if (!message) return null;

  if (message.imageMessage) {
    return { tipo: "imagem", mimetype: message.imageMessage.mimetype || "image/jpeg" };
  }
  if (message.videoMessage) {
    return { tipo: "vídeo", mimetype: message.videoMessage.mimetype || "video/mp4" };
  }
  if (message.audioMessage) {
    return { tipo: "áudio", mimetype: message.audioMessage.mimetype || "audio/ogg" };
  }
  if (message.stickerMessage) {
    return { tipo: "sticker", mimetype: message.stickerMessage.mimetype || "image/webp" };
  }
  if (message.documentMessage) {
    const mimetype = message.documentMessage.mimetype || "application/octet-stream";
    return {
      tipo: mimetype.startsWith("audio/") ? "áudio" : "documento",
      mimetype,
      filename: message.documentMessage.fileName || null,
    };
  }
  return null;
}

function isValidUserMessage(msg, type) {
  const jid = msg.key.remoteJid;
  if (type !== "notify") return false;
  if (!jid) return false;
  if (msg.key.fromMe) return false;
  if (jid.endsWith("@g.us")) return false;
  if (jid.endsWith("@newsletter")) return false;
  if (jid === "status@broadcast") return false;
  if (jid.endsWith("@broadcast")) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function parseMessageStatus(status) {
  switch (status) {
    case 1: return "sent";
    case 2: return "delivered";
    case 3: return "read";
    default: return "pending";
  }
}

module.exports = {
  unwrapMessage,
  getTextMessage,
  getMediaType,
  getMediaObject,
  isValidUserMessage,
  parseMessageStatus
};
