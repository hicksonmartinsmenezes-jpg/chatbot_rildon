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
  if (message.documentMessage) return "documento";
  if (message.imageMessage && !message.imageMessage.caption) return "imagem";
  if (message.videoMessage && !message.videoMessage.caption) return "vídeo";
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
  isValidUserMessage,
  parseMessageStatus
};
