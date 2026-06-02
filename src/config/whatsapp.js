const { getBotConfig }  = require("../services/botConfig.service");
const logger            = require("../utils/logger");
const { emitEvent }     = require("../services/socket.service");
const pool              = require("../database/postgres");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const pino   = require("pino");
const path   = require("path");

let sock              = null;
let reconnectAttempts = 0;
let reconnecting      = false;

// MELHORIA: cache em memória + confirmação no banco para deduplicação robusta
// O Set em memória é um atalho rápido; o banco garante que reinicializações
// não causem reprocessamento de mensagens recentes.
const processedMessages = new Set();
const MAX_RECONNECT_DELAY_MS = 30_000;

function getReconnectDelay() {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
  reconnectAttempts++;
  return delay;
}

function unwrapMessage(message) {
  if (!message) return null;
  if (message.ephemeralMessage)              return unwrapMessage(message.ephemeralMessage.message);
  if (message.viewOnceMessage)               return unwrapMessage(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2)             return unwrapMessage(message.viewOnceMessageV2.message);
  if (message.documentWithCaptionMessage)    return unwrapMessage(message.documentWithCaptionMessage.message);
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
  if (!message)                                               return null;
  if (message.audioMessage)                                   return "áudio";
  if (message.stickerMessage)                                 return "sticker";
  if (message.documentMessage)                                return "documento";
  if (message.imageMessage && !message.imageMessage.caption)  return "imagem";
  if (message.videoMessage && !message.videoMessage.caption)  return "vídeo";
  return null;
}

function isValidUserMessage(msg, type) {
  const jid = msg.key.remoteJid;
  if (type !== "notify")                  return false;
  if (!jid)                               return false;
  if (msg.key.fromMe)                     return false;
  if (jid.endsWith("@g.us"))              return false;
  if (jid.endsWith("@newsletter"))        return false;
  if (jid === "status@broadcast")         return false;
  if (jid.endsWith("@broadcast"))         return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function parseMessageStatus(status) {
  switch (status) {
    case 1:  return "sent";
    case 2:  return "delivered";
    case 3:  return "read";
    default: return "pending";
  }
}

/**
 * MELHORIA: deduplicação com duas camadas.
 * 1. Set em memória (rápido, válido por 5 min).
 * 2. Tabela `processed_messages` no banco (persiste entre reinicializações).
 *    Se o banco falhar, a camada de memória ainda protege contra duplicatas
 *    na mesma sessão.
 */
async function marcarMensagemProcessada(messageId) {
  if (!messageId) return false;

  // Camada 1: memória
  if (processedMessages.has(messageId)) return true;

  // Camada 2: banco
  try {
    const res = await pool.query(
      `INSERT INTO processed_messages (message_id, processed_at)
       VALUES ($1, NOW())
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [messageId]
    );
    // Se nenhuma linha foi inserida → já existia → duplicata
    if (res.rowCount === 0) {
      processedMessages.add(messageId);
      return true;
    }
  } catch (err) {
    logger.warn(`[Dedup] Erro ao checar banco: ${err.message} — usando apenas memória`);
  }

  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);
  return false;
}

async function limparSocketAntigo(oldSock) {
  try { oldSock?.end?.();                    } catch (_) {}
  try { oldSock?.ws?.close?.();              } catch (_) {}
  try { oldSock?.ev?.removeAllListeners?.(); } catch (_) {}
}

async function enviarComRetry(userId, response) {
  const currentSock = sock;
  if (!currentSock) {
    logger.error("Falha ao enviar: socket inexistente.");
    return false;
  }

  for (let i = 0; i < 3; i++) {
    try {
      await currentSock.sendMessage(userId, { text: response });
      logger.success(`Resposta enviada com sucesso. Tentativa ${i + 1}`);
      return true;
    } catch (err) {
      logger.warn(`Tentativa ${i + 1} falhou: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  logger.error("Falha definitiva ao enviar mensagem.");
  return false;
}

async function connectWhatsApp(onMessage) {
  if (typeof onMessage !== "function") {
    throw new Error("connectWhatsApp precisa receber processMessage.");
  }

  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, "../../auth_info")
  );

  const { version } = await fetchLatestBaileysVersion();

  if (sock?.ev) {
    sock.ev.removeAllListeners("messages.upsert");
    sock.ev.removeAllListeners("messages.update");
    sock.ev.removeAllListeners("presence.update");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
  }

  sock = makeWASocket({
    version,
    auth:                    state,
    logger:                  pino({ level: "fatal" }),
    printQRInTerminal:       false,
    syncFullHistory:         false,
    markOnlineOnConnect:     false,
    keepAliveIntervalMs:     10000,
    connectTimeoutMs:        60000,
    defaultQueryTimeoutMs:   60000,
    emitOwnEvents:           false,
    retryRequestDelayMs:     250
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info("Escaneie o QR Code abaixo com o WhatsApp");
      qrcode.generate(qr, { small: true });
      emitEvent("qr_code", { qr });
    }

    if (connection === "close") {
      const code           = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      logger.warn(`Conexão encerrada (código ${code})`);
      emitEvent("whatsapp_status", { status: "disconnected", code });

      if (shouldReconnect) {
        if (reconnecting) {
          logger.warn("Reconexão já em andamento...");
          return;
        }

        reconnecting = true;
        const delay   = getReconnectDelay();
        const oldSock = sock;

        logger.info(`Reconectando em ${delay / 1000}s... (tentativa ${reconnectAttempts})`);

        setTimeout(async () => {
          try {
            await limparSocketAntigo(oldSock);
            await connectWhatsApp(onMessage);
          } finally {
            reconnecting = false;
          }
        }, delay);

        return;
      }

      logger.warn("Sessão encerrada. Delete a pasta auth_info e reinicie.");
      emitEvent("whatsapp_status", { status: "logged_out" });
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      reconnecting      = false;
      logger.success("WhatsApp conectado com sucesso!");
      emitEvent("whatsapp_status", { status: "connected" });
    }
  });

  sock.ev.on("presence.update", update => {
    const userId = update.id;
    if (!userId)                        return;
    if (userId.endsWith("@g.us"))       return;
    if (userId === "status@broadcast")  return;

    const isTyping = Object.values(update.presences || {}).some(
      p => p.lastKnownPresence === "composing"
    );
    if (isTyping) emitEvent("typing", { userId, from: "client" });
  });

  sock.ev.on("messages.update", async updates => {
    for (const update of updates) {
      const key = update.key;
      if (!key?.id) continue;
      emitEvent("message_status", {
        messageId: key.id,
        status:    parseMessageStatus(update.update?.status)
      });
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const msg of messages) {
      const messageId = msg.key?.id;

      // MELHORIA: deduplicação com persistência no banco
      if (await marcarMensagemProcessada(messageId)) {
        logger.warn(`Mensagem duplicada ignorada: ${messageId}`);
        continue;
      }

      const jid = msg.key.remoteJid;

      if (!isValidUserMessage(msg, type)) {
        if (!msg.key.fromMe) logger.info(`Mensagem ignorada | type=${type} | jid=${jid}`);
        continue;
      }

      const userId = jid;

      const contactName =
        msg.pushName ||
        msg.verifiedBizName ||
        msg.notifyName ||
        "";

      const text = getTextMessage(msg).trim();

      const botConfig = await getBotConfig();
      if (botConfig.ativo === false || botConfig.ativo === "false") {
        logger.warn("Bot desativado. Mensagem ignorada.");
        continue;
      }

      if (!text) {
        const tipoMidia = getMediaType(msg);
        if (tipoMidia) {
          try {
            await enviarComRetry(
              userId,
              `⚠️ Recebi seu ${tipoMidia}, mas ainda não consigo processar arquivos.\n\n` +
              `Por favor, descreva sua dúvida em *texto* e será um prazer ajudar! 😊\n\n` +
              `Digite *0* para ver o menu.`
            );
          } catch (err) {
            logger.error(`Erro ao enviar aviso de mídia: ${err.message}`);
          }
        }
        continue;
      }

      try {
        logger.info(`Mensagem recebida de ${userId}: ${text}`);
        const response = await onMessage({ userId, contactName, message: text });
        if (!response) { logger.warn("Nenhuma resposta retornada."); continue; }
        await enviarComRetry(userId, response);
      } catch (err) {
        logger.error(`Erro ao processar mensagem: ${err.message}`);
      }
    }
  });
}

async function getProfilePhotoUrl(userId) {
  if (!sock) return null;
  try {
    let jid = String(userId).replace("@lid", "");
    if (!jid.includes("@s.whatsapp.net")) jid = `${jid}@s.whatsapp.net`;
    return await sock.profilePictureUrl(jid, "image");
  } catch {
    return null;
  }
}

async function sendMessage(userId, text) {
  if (!sock) throw new Error("WhatsApp não está conectado.");
  const sent = await sock.sendMessage(userId, { text });
  logger.success(`Mensagem enviada para ${userId}`);
  return { id: sent.key.id, remoteJid: sent.key.remoteJid, fromMe: sent.key.fromMe };
}

async function sendMedia(userId, filePath, caption = "") {

  if (!sock) {
    throw new Error("WhatsApp não está conectado.");
  }

  const sent = await sock.sendMessage(
    userId,
    {
      image: {
        url: filePath
      },
      caption
    }
  );

  logger.success(`Imagem enviada para ${userId}`);

  return {
    id: sent.key.id,
    remoteJid: sent.key.remoteJid,
    fromMe: sent.key.fromMe
  };
}

function getSocket() {
  return sock;
}

async function sendTypingPresence(userId) {
  if (!sock) return;
  await sock.presenceSubscribe(userId);
  await sock.sendPresenceUpdate("composing", userId);
  setTimeout(async () => {
    try { await sock.sendPresenceUpdate("paused", userId); } catch (_) {}
  }, 3000);
}

module.exports = {
  connectWhatsApp,
  sendMessage,
  sendMedia,
  getProfilePhotoUrl,
  getSocket,
  sendTypingPresence
};
