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
const fs     = require("fs");

let sock              = null;
let reconnectAttempts = 0;
let reconnecting      = false;
let isWhatsAppConnected = false;
let cachedConfig = null;
let lastConfigCheck = 0;

// Mapa LID (@lid) → JID real (@s.whatsapp.net) preenchido pelo evento contacts.upsert
// e pelas mensagens recebidas (senderPn). Leitura é sempre em memória; a escrita
// no banco é assíncrona e só ocorre quando o valor muda — sem latência no envio.
const lidToJid = {};
let _lidMapCarregado = false;

function setLidMapping(lid, jid, source = "") {
  if (!lid || !jid || lidToJid[lid] === jid) return;
  lidToJid[lid] = jid;
  logger.info(`[lidToJid] ${lid} → ${jid}${source ? ` (via ${source})` : ""}`);
  pool.query(
    `INSERT INTO lid_map (lid, jid, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (lid) DO UPDATE SET jid = EXCLUDED.jid, updated_at = NOW()`,
    [lid, jid]
  ).catch(err => logger.warn(`[lidToJid] persistência falhou: ${err.message}`));
}

async function carregarLidMap() {
  if (_lidMapCarregado) return;       // carrega uma única vez (sobrevive a reconexões)
  _lidMapCarregado = true;
  try {
    const res = await pool.query(`SELECT lid, jid FROM lid_map`);
    for (const row of res.rows) lidToJid[row.lid] = row.jid;
    if (res.rowCount) logger.info(`[lidToJid] ${res.rowCount} mapeamento(s) restaurado(s) do banco`);
  } catch (err) {
    logger.warn(`[lidToJid] Falha ao restaurar do banco: ${err.message}`);
  }
}


// Map com TTL por entrada: evita clear abrupto que abriria janela de duplicatas
const processedMessages = new Map(); // id → timestamp
const PROCESSED_TTL_MS  = 5 * 60 * 1000; // 5 min
const PROCESSED_MAX     = 10_000;

// Dedup secundário por conteúdo — captura duplicatas de @lid com IDs diferentes
// que Baileys entrega dentro da mesma janela de tempo
const recentContent = new Map(); // `userId:text` → timestamp
const CONTENT_TTL_MS = 8_000; // 8 segundos

function isDuplicateContent(userId, text) {
  const key = `${userId}:${text}`;
  const ts  = recentContent.get(key);
  if (ts && Date.now() - ts < CONTENT_TTL_MS) return true;
  recentContent.set(key, Date.now());
  // Limpeza incremental
  if (recentContent.size > 500) {
    const cutoff = Date.now() - CONTENT_TTL_MS;
    for (const [k, t] of recentContent) {
      if (t < cutoff) recentContent.delete(k);
    }
  }
  return false;
}

function markProcessed(id) {
  processedMessages.set(id, Date.now());
  // Limpeza incremental: remove entradas expiradas quando mapa fica grande
  if (processedMessages.size > PROCESSED_MAX) {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    for (const [msgId, ts] of processedMessages) {
      if (ts < cutoff) processedMessages.delete(msgId);
    }
  }
}

function isProcessed(id) {
  const ts = processedMessages.get(id);
  if (!ts) return false;
  if (Date.now() - ts > PROCESSED_TTL_MS) {
    processedMessages.delete(id);
    return false;
  }
  return true;
}

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
  if (isProcessed(messageId)) return true;

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
      markProcessed(messageId);
      return true;
    }
  } catch (err) {
    logger.warn(`[Dedup] Erro ao checar banco: ${err.message}`);
  }

  markProcessed(messageId);
  return false;
}

async function limparSocketAntigo(oldSock) {
  try { oldSock?.end?.();                    } catch (_) {}
  try { oldSock?.ws?.close?.();              } catch (_) {}
  try { oldSock?.ev?.removeAllListeners?.(); } catch (_) {}
}

async function enviarComRetry(userId, response) {
  // Captura o socket atual. Não bloqueia por flags — o retry loop
  // trata falhas de conexão diretamente, incluindo casos onde o
  // evento "connection.open" não disparou (JIDs @lid / linked devices).
  const currentSock = sock;

  if (!currentSock) {
    logger.warn("Socket não disponível. Cancelando envio.");
    return false;
  }

  for (let i = 0; i < 3; i++) {
    try {
      await currentSock.sendMessage(userId, { text: response });
      // Garante que o flag fica sincronizado
      if (!isWhatsAppConnected) isWhatsAppConnected = true;
      logger.info(`[WhatsApp] ✓ Resposta enviada. Tentativa ${i + 1}`);
      return true;
    } catch (err) {
      logger.warn(`Tentativa ${i + 1} falhou: ${err.message}`);
      if (i < 2) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  logger.error("Falha definitiva ao enviar mensagem.");
  return false;
}

async function connectWhatsApp(onMessage) {
  if (typeof onMessage !== "function") {
    throw new Error("connectWhatsApp precisa receber processMessage.");
  }

  // Restaura o mapa @lid → JID do banco (uma vez) para sobreviver a restarts
  await carregarLidMap();

  let state, saveCreds, version;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(
      path.join(__dirname, "../../auth_info")
    ));
    ({ version } = await fetchLatestBaileysVersion());
  } catch (err) {
    logger.error(`[WhatsApp] Falha ao inicializar: ${err.message}`);
    emitEvent("whatsapp_status", { status: "error", message: err.message });
    throw err;
  }

  if (sock?.ev) {
    sock.ev.removeAllListeners("messages.upsert");
    sock.ev.removeAllListeners("messages.update");
    sock.ev.removeAllListeners("presence.update");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("contacts.upsert");
    sock.ev.removeAllListeners("contacts.set");
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

  function processContacts(contacts, source) {
    logger.info(`[${source}] ${contacts.length} contatos`);
    for (const c of contacts) {
      if (c.lid && c.id && !c.id.includes("@lid")) {
        setLidMapping(c.lid, c.id, source);
      }
      if (c.id && c.id.includes("@lid") && (c.phone || c.number)) {
        const phone = (c.phone || c.number).replace(/\D/g, "");
        setLidMapping(c.id, `${phone}@s.whatsapp.net`, `${source}/phone`);
      }
    }
    logger.info(`[lidToJid] mapa total: ${Object.keys(lidToJid).length} entradas`);
  }

  sock.ev.on("contacts.upsert", contacts => processContacts(contacts, "contacts.upsert"));
  sock.ev.on("contacts.set",    ({ contacts }) => processContacts(contacts || [], "contacts.set"));

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info("Escaneie o QR Code abaixo com o WhatsApp");
      qrcode.generate(qr, { small: true });
      emitEvent("qr_code", { qr });
    }

    if (connection === "close") {
      isWhatsAppConnected = false;

      const code           = lastDisconnect?.error?.output?.statusCode;
     const shouldReconnect =
      code !== DisconnectReason.loggedOut &&
      code !== 401 &&
      code !== 440;

      logger.warn(`Conexão encerrada (código ${code})`);
      if (code === 401 || code === 440) {
  try {
    fs.rmSync(
      path.join(__dirname, "../../auth_info"),
      {
        recursive: true,
        force: true
      }
    );

    logger.warn(
      "Sessão inválida removida automaticamente."
    );
  } catch (err) {
    logger.error(
      `Erro removendo auth_info: ${err.message}`
    );
  }
}


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

      logger.warn("Sessão encerrada. Novo QR Code será necessário.");
      emitEvent("whatsapp_status", { status: "logged_out" });
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      reconnecting      = false;
      isWhatsAppConnected = true;
      logger.info("[WhatsApp] ✓ Conectado com sucesso!");
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
            logger.debug?.(
        `Duplicada ignorada`
      );
        continue;
      }

      const jid = msg.key.remoteJid;

      if (!isValidUserMessage(msg, type)) {
        if (!msg.key.fromMe) logger.info(`Mensagem ignorada | type=${type} | jid=${jid}`);
        continue;
      }

      // Resolve LID → JID real (número de telefone) quando disponível
      let userId = jid;
      if (jid.includes("@lid")) {
        if (lidToJid[jid]) {
          userId = lidToJid[jid];
          logger.info(`[LID→JID] ${jid} → ${userId}`);
        } else if (msg.key.senderPn) {
          // senderPn contém o número real mesmo quando o mapa lidToJid ainda não foi populado
          userId = msg.key.senderPn;
          setLidMapping(jid, userId, "senderPn"); // cacheia e persiste para as próximas mensagens
        } else {
          logger.warn(`[msg@lid sem resolução] key=${JSON.stringify(msg.key)} pushName=${msg.pushName || ""}`);
        }
      }

      const contactName =
        msg.pushName ||
        msg.verifiedBizName ||
        msg.notifyName ||
        "";

      // Auto-registro: salva o contato na tabela contacts se ainda não existir
      if (userId.endsWith("@s.whatsapp.net")) {
        const phone = userId.replace("@s.whatsapp.net", "");
        pool.query(
          `INSERT INTO contacts (nome, whatsapp)
           SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM contacts WHERE whatsapp = $2)`,
          [contactName || phone, phone]
        ).catch(err => logger.warn(`[AutoContact] ${err.message}`));
      }

      const text = getTextMessage(msg).trim();

     const botConfig = await getBotConfigCached();
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

      // Dedup secundário: mesma mensagem entregue duas vezes pelo Baileys com IDs diferentes (@lid)
      if (isDuplicateContent(userId, text)) {
        logger.debug?.(`[Dedup-conteúdo] Ignorada: ${userId} → "${text}"`);
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
  const raw = String(userId);
  const resolvedJid = lidToJid[raw] || raw;

  // Tenta o JID resolvido primeiro (se disponível no mapa)
  if (resolvedJid !== raw) {
    try {
      const url = await sock.profilePictureUrl(resolvedJid, "image");
      if (url) return url;
    } catch (_) {}
  }

  // Tenta com o JID original
  try {
    const url = await sock.profilePictureUrl(raw, "image");
    if (url) return url;
  } catch (_) {}

  return null;
}

async function sendMessage(userId, text) {
  if (!sock) throw new Error("WhatsApp não inicializado.");
  if (!isWhatsAppConnected) throw new Error("WhatsApp não autenticado. Escaneie o QR Code no painel.");

  try {
    // Resolve @lid → JID real (telefone) usando o mapa populado no recebimento.
    // Sem isso, mensagens manuais do painel para um @lid falham na entrega ("Aguardando mensagem").
    let resolvedJid = lidToJid[userId] || userId;
    if (resolvedJid !== userId) {
      logger.info(`[sendMessage] @lid resolvido via mapa: ${userId} → ${resolvedJid}`);
    }

    // JIDs @lid são identificadores de dispositivo — não passam por onWhatsApp()
    if (!resolvedJid.endsWith("@lid")) {
      const numero = resolvedJid.replace(/@.+/, "");
      const [check] = await sock.onWhatsApp(numero).catch(() => [null]);
      if (!check?.exists) {
        throw new Error(`Número ${numero} não está registrado no WhatsApp.`);
      }
      if (check.jid && check.jid !== resolvedJid) {
        logger.info(`[sendMessage] JID normalizado: ${resolvedJid} → ${check.jid}`);
        resolvedJid = check.jid;
      }
    }

    const sent = await sock.sendMessage(resolvedJid, { text });
    logger.info(`[sendMessage] ✓ Enviado para ${resolvedJid}`);

    return { id: sent.key.id, remoteJid: sent.key.remoteJid, fromMe: sent.key.fromMe };

  } catch (err) {
    logger.error(`Falha ao enviar mensagem: ${err.message}`);
    if (err.message?.includes("Connection Closed") || err.output?.statusCode === 428) {
      logger.warn("WhatsApp desconectado. Ignorando envio.");
      return { id: null, remoteJid: userId, fromMe: true };
    }
    throw err;
  }
}

async function sendMedia(userId, filePath, caption = "", mediaType = "image") {
  if (!sock) throw new Error("WhatsApp não inicializado.");
  if (!isWhatsAppConnected) throw new Error("WhatsApp não autenticado. Escaneie o QR Code no painel.");

  try {
    // Resolve @lid → JID real via mapa (mesma lógica de sendMessage)
    let resolvedJid = lidToJid[userId] || userId;

    if (!resolvedJid.endsWith("@lid")) {
      const numero = resolvedJid.replace(/@.+/, "");
      const [check] = await sock.onWhatsApp(numero).catch(() => [null]);
      if (!check?.exists) {
        throw new Error(`Número ${numero} não está registrado no WhatsApp.`);
      }
      resolvedJid = check.jid || resolvedJid;
    }

    let msgContent;
    const fileData = { url: filePath };
    const path = require("path");
    const fileName = path.basename(filePath);

    if (mediaType === "pdf") {
      msgContent = {
        document: fileData,
        mimetype: "application/pdf",
        fileName,
        caption: caption || undefined,
      };
    } else if (mediaType === "audio") {
      msgContent = {
        audio: fileData,
        mimetype: "audio/mpeg",
        ptt: false,
      };
    } else {
      msgContent = { image: fileData, caption: caption || undefined };
    }

    const sent = await sock.sendMessage(resolvedJid, msgContent);
    logger.info(`[WhatsApp] ✓ Mídia (${mediaType}) enviada para ${resolvedJid}`);

    return { id: sent.key.id, remoteJid: sent.key.remoteJid, fromMe: sent.key.fromMe };

  } catch (err) {
    logger.error(`Erro ao enviar mídia: ${err.message}`);
    throw err;
  }
}
function getSocket() {
  return sock;
}

function resolveLid(lid) {
  return lidToJid[lid] || null;
}

async function sendTypingPresence(userId) {
  if (!sock || !isWhatsAppConnected) return;

  try {
    await sock.presenceSubscribe(userId);
    await sock.sendPresenceUpdate("composing", userId);

    setTimeout(async () => {
      try {
        await sock.sendPresenceUpdate("paused", userId);
      } catch (_) {}
    }, 3000);

  } catch (err) {
    logger.warn(
      `Erro ao enviar presença: ${err.message}`
    );
  }
}

function isConnected() {
  return !!sock && isWhatsAppConnected;
}

setInterval(async () => {
  try {
    await pool.query(`
      DELETE FROM processed_messages
      WHERE processed_at < NOW() - INTERVAL '7 days'
    `);
  } catch (err) {
    logger.warn(`Erro limpando dedup: ${err.message}`);
  }
}, 24 * 60 * 60 * 1000);


async function getBotConfigCached() {
  const now = Date.now();

  if (
    cachedConfig &&
    now - lastConfigCheck < 30000
  ) {
    return cachedConfig;
  }

  cachedConfig = await getBotConfig();
  lastConfigCheck = now;

  return cachedConfig;
}

module.exports = {
  connectWhatsApp,
  sendMessage,
  sendMedia,
  getProfilePhotoUrl,
  getSocket,
  resolveLid,
  sendTypingPresence,
  isConnected
};
