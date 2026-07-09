const { getBotConfig }  = require("../services/botConfig.service");
const logger            = require("../utils/logger");
const { emitEvent }     = require("../services/socket.service");
const {
  setLidMapping,
  carregarLidMap,
  resolveLid,
  resolveJidToLid,
  resolveSendJid,
  getProfilePhotoCandidates,
  getLidMapStats
} = require("../whatsapp/lid-map");
const {
  getTextMessage,
  getMediaType,
  isValidUserMessage,
  parseMessageStatus
} = require("../whatsapp/message-utils");
const { isDuplicateContent, marcarMensagemProcessada, startDedupCleanup } = require("../whatsapp/dedup");
const { autoRegisterContact } = require("../whatsapp/contacts");

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

// Estado da conexão — antes eram 8 variáveis `let` soltas no topo do módulo,
// lidas/escritas por closure em todos os handlers abaixo. Consolidadas aqui
// num único objeto explícito (sem mudar nenhum comportamento) para deixar
// claro, num só lugar, tudo que descreve "a conexão atual" com o WhatsApp.
const conn = {
  sock:                null,
  reconnectAttempts:   0,
  reconnecting:        false,
  isWhatsAppConnected: false,
  cachedConfig:        null,
  lastConfigCheck:     0,
  messageHandler:      null, // processMessage — guardado para reconexões forçadas
  lastQr:              null  // último QR pendente (até conectar) — permite buscar via API
};

const MAX_RECONNECT_DELAY_MS = 30_000;
const MESSAGE_PROCESSING_TIMEOUT_MS = Number(process.env.BOT_MESSAGE_TIMEOUT_MS || 45_000);
const BOT_PROCESSING_FALLBACK =
  process.env.BOT_PROCESSING_FALLBACK ||
  "⚠️ Estou com uma instabilidade momentânea para processar sua mensagem. Tente novamente em instantes ou aguarde um atendente.";

function withTimeout(promise, timeoutMs, label = "operação") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getReconnectDelay() {
  const delay = Math.min(1000 * 2 ** conn.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
  conn.reconnectAttempts++;
  return delay;
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
  const currentSock = conn.sock;

  if (!currentSock) {
    logger.warn("Socket não disponível. Cancelando envio.");
    return false;
  }

  for (let i = 0; i < 3; i++) {
    try {
      await currentSock.sendMessage(userId, { text: response });
      // Garante que o flag fica sincronizado
      if (!conn.isWhatsAppConnected) conn.isWhatsAppConnected = true;
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

// ─── Handlers de eventos do socket ───────────────────────────────────────────
// Extraídos como funções nomeadas de nível de módulo (em vez de closures
// inline dentro de connectWhatsApp) só para reduzir o tamanho e a
// profundidade de aninhamento da função de conexão. Continuam no mesmo
// arquivo porque dependem do estado compartilhado via closure sobre `conn`
// (sock, isWhatsAppConnected, reconnectAttempts etc.) — mover para outro
// módulo é possível agora que o estado é um objeto explícito (bastaria
// passar `conn` como parâmetro), mas fica para uma refatoração futura
// dedicada, já que essa extração por si só não muda comportamento nenhum.

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
  logger.info(`[lidToJid] mapa total: ${getLidMapStats().lidToJid} entradas`);
}

// Handler de connection.update: QR code, desconexão (com backoff de
// reconexão) e confirmação de conexão aberta.
async function onConnectionUpdate({ connection, lastDisconnect, qr }) {
  if (qr) {
    conn.lastQr = qr; // mantém o QR disponível para quem abrir o painel depois do evento
    logger.info("Escaneie o QR Code abaixo com o WhatsApp");
    qrcode.generate(qr, { small: true });
    emitEvent("qr_code", { qr });
  }

  if (connection === "close") {
    conn.isWhatsAppConnected = false;

    const code = lastDisconnect?.error?.output?.statusCode;
    const shouldReconnect =
      code !== DisconnectReason.loggedOut &&
      code !== 401 &&
      code !== 440;

    logger.warn(`Conexão encerrada (código ${code})`);
    if (code === 401 || code === 440) {
      try {
        fs.rmSync(
          path.join(__dirname, "../../auth_info"),
          { recursive: true, force: true }
        );
        logger.warn("Sessão inválida removida automaticamente.");
      } catch (err) {
        logger.error(`Erro removendo auth_info: ${err.message}`);
      }
    }

    emitEvent("whatsapp_status", { status: "disconnected", code });

    if (shouldReconnect) {
      if (conn.reconnecting) {
        logger.warn("Reconexão já em andamento...");
        return;
      }

      conn.reconnecting = true;
      const delay   = getReconnectDelay();
      const oldSock = conn.sock;

      logger.info(`Reconectando em ${delay / 1000}s... (tentativa ${conn.reconnectAttempts})`);

      setTimeout(async () => {
        try {
          await limparSocketAntigo(oldSock);
          await connectWhatsApp(conn.messageHandler);
        } finally {
          conn.reconnecting = false;
        }
      }, delay);

      return;
    }

    logger.warn("Sessão encerrada. Novo QR Code será necessário.");
    emitEvent("whatsapp_status", { status: "logged_out" });
  }

  if (connection === "open") {
    conn.reconnectAttempts   = 0;
    conn.reconnecting        = false;
    conn.isWhatsAppConnected = true;
    conn.lastQr              = null; // conectou: não há mais QR pendente
    logger.info("[WhatsApp] ✓ Conectado com sucesso!");
    emitEvent("whatsapp_status", { status: "connected" });
  }
}

function onPresenceUpdate(update) {
  const userId = update.id;
  if (!userId)                        return;
  if (userId.endsWith("@g.us"))       return;
  if (userId === "status@broadcast")  return;

  const isTyping = Object.values(update.presences || {}).some(
    p => p.lastKnownPresence === "composing"
  );
  if (isTyping) emitEvent("typing", { userId, from: "client" });
}

async function onMessagesUpdate(updates) {
  for (const update of updates) {
    const key = update.key;
    if (!key?.id) continue;
    emitEvent("message_status", {
      messageId: key.id,
      status:    parseMessageStatus(update.update?.status)
    });
  }
}

// Handler de messages.upsert: pipeline completo de uma mensagem recebida —
// dedup, resolução de LID, auto-registro de contato, checagem de bot
// ativo/inativo, tratamento de mídia sem texto, dedup de conteúdo e,
// finalmente, chamada ao processMessage (messageHandler) com timeout e
// fallback amigável em caso de erro.
async function onMessagesUpsert({ messages, type }) {
  for (const msg of messages) {
    const messageId = msg.key?.id;

    // MELHORIA: deduplicação com persistência no banco
    if (await marcarMensagemProcessada(messageId)) {
      logger.debug?.("Duplicada ignorada");
      continue;
    }

    const jid = msg.key.remoteJid;

    if (!isValidUserMessage(msg, type)) {
      if (!msg.key.fromMe) logger.info(`Mensagem ignorada | type=${type} | jid=${jid}`);
      continue;
    }

    // Resolve LID → JID real (número de telefone) quando disponível.
    // sendTo = JID usado para ENVIAR a resposta (mantemos @lid quando possível,
    //          pois a sessão Signal foi estabelecida com esse JID).
    // userId = JID normalizado (número) usado para histórico, contexto e painel.
    let userId = jid;
    let sendTo = jid; // JID de destino para enviar — começa igual ao recebido

    if (jid.includes("@lid")) {
      const resolvedFromMap = resolveLid(jid);
      if (resolvedFromMap) {
        userId = resolvedFromMap;
        // sendTo permanece @lid: sessão Signal está ativa com esse JID,
        // responder ao número causaria novo handshake → "Aguardando mensagem"
        logger.info(`[LID→JID] ${jid} → ${userId} (resposta via @lid)`);
      } else if (msg.key.senderPn) {
        // Normaliza senderPn para JID completo
        const rawPn = String(msg.key.senderPn).replace(/[^\d]/g, "");
        userId = `${rawPn}@s.whatsapp.net`;
        setLidMapping(jid, userId, "senderPn");
        // Aqui não temos sessão com o número — usamos o @lid mesmo
        logger.info(`[senderPn] ${jid} → ${userId} (resposta via @lid)`);
      } else {
        // Não perde mensagem @lid sem resolução. Mantém o próprio @lid como
        // identificador de conversa/ticket e responde pelo mesmo JID.
        userId = jid;
        sendTo = jid;
        logger.warn(`[LID_FALLBACK] ${jid} sem resolução; mensagem será salva/respondida via @lid. pushName=${msg.pushName || ""}`);
      }
    }

    const contactName =
      msg.pushName ||
      msg.verifiedBizName ||
      msg.notifyName ||
      "";

    // Auto-registro: salva/atualiza o contato sem bloquear o fluxo da mensagem.
    // Importante: esta função usa casts explícitos e SELECT prévio para evitar o erro
    // "inconsistent types deduced for parameter" do PostgreSQL.
    await autoRegisterContact(userId, contactName);

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
            sendTo,
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
      logger.info(`[MESSAGE_IN] ${userId}: ${text}`);

      // UX: mostra "digitando..." antes de processar IA/fluxo quando possível.
      sendTypingPresence(sendTo).catch(err =>
        logger.debug?.(`[Typing] não enviado para ${sendTo}: ${err.message}`)
      );

      const response = await withTimeout(
        conn.messageHandler({ userId, contactName, message: text }),
        MESSAGE_PROCESSING_TIMEOUT_MS,
        "processamento do bot"
      );

      // Retorno vazio é normal quando atendimento humano está ativo.
      if (!response) {
        logger.debug?.(`[MESSAGE_NO_BOT_RESPONSE] ${userId}`);
        continue;
      }

      await enviarComRetry(sendTo, response);
    } catch (err) {
      logger.error(`[BOT_PROCESSING_ERROR] ${userId}: ${err.stack || err.message}`);
      try {
        await enviarComRetry(sendTo, BOT_PROCESSING_FALLBACK);
      } catch (sendErr) {
        logger.error(`[BOT_FALLBACK_SEND_ERROR] ${userId}: ${sendErr.message}`);
      }
      emitEvent("bot_error", {
        userId,
        message: "Erro ao processar mensagem do cliente.",
        detail: err.message,
        createdAt: new Date()
      });
    }
  }
}

async function connectWhatsApp(onMessage) {
  if (typeof onMessage !== "function") {
    throw new Error("connectWhatsApp precisa receber processMessage.");
  }

  // Guarda o handler para que forceReconnect() e a reconexão automática
  // possam reiniciar a conexão sozinhas (os handlers de evento acima usam
  // conn.messageHandler, não o parâmetro local, justamente por isso).
  conn.messageHandler = onMessage;

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

  if (conn.sock?.ev) {
    conn.sock.ev.removeAllListeners("messages.upsert");
    conn.sock.ev.removeAllListeners("messages.update");
    conn.sock.ev.removeAllListeners("presence.update");
    conn.sock.ev.removeAllListeners("connection.update");
    conn.sock.ev.removeAllListeners("creds.update");
    conn.sock.ev.removeAllListeners("contacts.upsert");
    conn.sock.ev.removeAllListeners("contacts.set");
  }

  conn.sock = makeWASocket({
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

  conn.sock.ev.on("creds.update", saveCreds);
  conn.sock.ev.on("contacts.upsert", contacts => processContacts(contacts, "contacts.upsert"));
  conn.sock.ev.on("contacts.set",    ({ contacts }) => processContacts(contacts || [], "contacts.set"));
  conn.sock.ev.on("connection.update", onConnectionUpdate);
  conn.sock.ev.on("presence.update", onPresenceUpdate);
  conn.sock.ev.on("messages.update", onMessagesUpdate);
  conn.sock.ev.on("messages.upsert", onMessagesUpsert);
}


async function getProfilePhotoUrl(userId) {
  if (!conn.sock) return null;

  const candidates = getProfilePhotoCandidates(userId);

  for (const jid of candidates) {
    try {
      const url = await conn.sock.profilePictureUrl(jid, "image");
      if (url) {
        logger.debug?.(`[FotoContato] foto encontrada para ${userId} via ${jid}`);
        return url;
      }
    } catch (err) {
      logger.debug?.(`[FotoContato] sem foto para candidato ${jid}: ${err?.message || err}`);
    }
  }

  logger.debug?.(`[FotoContato] nenhuma foto encontrada para ${userId}. candidatos=${candidates.join(",")}`);
  return null;
}

async function sendMessage(userId, text) {
  if (!conn.sock) throw new Error("WhatsApp não inicializado.");
  if (!conn.isWhatsAppConnected) throw new Error("WhatsApp não autenticado. Escaneie o QR Code no painel.");

  try {
    let resolvedJid = resolveSendJid(userId);
    if (resolvedJid !== userId) {
      logger.info(`[sendMessage] destino resolvido: ${userId} → ${resolvedJid}`);
    }

    // JIDs @lid são identificadores de dispositivo — não passam por onWhatsApp()
    if (!resolvedJid.endsWith("@lid")) {
      const numero = resolvedJid.replace(/@.+/, "");
      const [check] = await conn.sock.onWhatsApp(numero).catch(() => [null]);
      if (!check?.exists) {
        throw new Error(`Número ${numero} não está registrado no WhatsApp.`);
      }
      if (check.jid && check.jid !== resolvedJid) {
        logger.info(`[sendMessage] JID normalizado: ${resolvedJid} → ${check.jid}`);
        resolvedJid = check.jid;
      }
    }

    const sent = await conn.sock.sendMessage(resolvedJid, { text });
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
  if (!conn.sock) throw new Error("WhatsApp não inicializado.");
  if (!conn.isWhatsAppConnected) throw new Error("WhatsApp não autenticado. Escaneie o QR Code no painel.");

  try {
    // Mesma lógica de sendMessage: se o número tem @lid conhecido, envia pelo @lid.
    let resolvedJid = resolveSendJid(userId);

    if (!resolvedJid.endsWith("@lid")) {
      const numero = resolvedJid.replace(/@.+/, "");
      const [check] = await conn.sock.onWhatsApp(numero).catch(() => [null]);
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

    const sent = await conn.sock.sendMessage(resolvedJid, msgContent);
    logger.info(`[WhatsApp] ✓ Mídia (${mediaType}) enviada para ${resolvedJid}`);

    return { id: sent.key.id, remoteJid: sent.key.remoteJid, fromMe: sent.key.fromMe };

  } catch (err) {
    logger.error(`Erro ao enviar mídia: ${err.message}`);
    throw err;
  }
}
function getSocket() {
  return conn.sock;
}

async function sendTypingPresence(userId) {
  if (!conn.sock || !conn.isWhatsAppConnected) return;

  try {
    await conn.sock.presenceSubscribe(userId);
    await conn.sock.sendPresenceUpdate("composing", userId);

    setTimeout(async () => {
      try {
        await conn.sock.sendPresenceUpdate("paused", userId);
      } catch (_) {}
    }, 3000);

  } catch (err) {
    logger.warn(
      `Erro ao enviar presença: ${err.message}`
    );
  }
}

function isConnected() {
  return !!conn.sock && conn.isWhatsAppConnected;
}

startDedupCleanup();


async function getBotConfigCached() {
  const now = Date.now();

  if (
    conn.cachedConfig &&
    now - conn.lastConfigCheck < 30000
  ) {
    return conn.cachedConfig;
  }

  conn.cachedConfig = await getBotConfig();
  conn.lastConfigCheck = now;

  return conn.cachedConfig;
}

// Estado da conexão para o painel: { connected, qr }
// Permite que o frontend busque um QR pendente mesmo que tenha aberto o painel
// depois do evento socket "qr_code" (que é efêmero).
function getConnectionInfo() {
  return { connected: conn.isWhatsAppConnected, qr: conn.lastQr };
}

// Encerra a sessão atual e RECONECTA explicitamente para forçar novo QR Code.
// Importante: limparSocketAntigo() remove todos os listeners (inclusive o
// connection.update que dispararia a reconexão automática), então precisamos
// chamar connectWhatsApp() nós mesmos — não dá para confiar no handler de close.
// clearSession=true apaga auth_info (re-pareamento total: sempre gera QR novo).
async function forceReconnect(opts = {}) {
  const { clearSession = false } = opts;
  logger.warn(`[WhatsApp] Reconexão forçada solicitada pelo painel.${clearSession ? " (limpando sessão)" : ""}`);

  conn.isWhatsAppConnected = false;
  conn.lastQr              = null;
  conn.reconnecting        = false; // libera para a nova conexão não ser bloqueada
  conn.reconnectAttempts   = 0;     // zera backoff

  const oldSock = conn.sock;
  conn.sock = null;
  await limparSocketAntigo(oldSock);

  if (clearSession) {
    try {
      fs.rmSync(path.join(__dirname, "../../auth_info"), { recursive: true, force: true });
      logger.warn("[WhatsApp] Sessão (auth_info) removida — novo QR será gerado.");
    } catch (err) {
      logger.error(`[WhatsApp] Erro removendo auth_info: ${err.message}`);
    }
  }

  if (typeof conn.messageHandler === "function") {
    await connectWhatsApp(conn.messageHandler);
  } else {
    logger.error("[WhatsApp] messageHandler ausente — não foi possível reconectar.");
    throw new Error("WhatsApp ainda não foi inicializado.");
  }
}

module.exports = {
  connectWhatsApp,
  sendMessage,
  sendMedia,
  getProfilePhotoUrl,
  getSocket,
  resolveLid,
  resolveJidToLid,
  sendTypingPresence,
  isConnected,
  forceReconnect,
  getConnectionInfo
};
