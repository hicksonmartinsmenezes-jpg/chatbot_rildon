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
  unwrapMessage,
  getTextMessage,
  getMediaType,
  getMediaObject,
  isValidUserMessage,
  parseMessageStatus
} = require("../whatsapp/message-utils");
const { isDuplicateContent, marcarMensagemProcessada, startDedupCleanup } = require("../whatsapp/dedup");
const { autoRegisterContact } = require("../whatsapp/contacts");
const { saveHistory } = require("../services/history.service");
const { analisarImagemPeca, suportaVisao, transcreverAudio, suportaAudio } = require("../services/ai.service");
const { salvarMidiaRecebida } = require("../services/mediaStorage.service");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
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

// Analisa foto enviada sem legenda via IA de visão (quando o provedor ativo
// suporta imagem — ver suportaVisao() em ai.service.js). Baixa a mídia em
// memória (nunca persistida em disco), converte para base64 e pede uma
// descrição textual curta pro provedor; essa descrição então passa pelo
// MESMO pipeline de uma mensagem digitada (mainFlow, sessão, histórico,
// socket) — nenhuma lógica de negócio duplicada pra extrair veículo/peça.
// Retorna null em qualquer falha (mídia expirada, provedor indisponível,
// imagem não reconhecida como peça/veículo), sinalizando pro chamador usar
// o fallback padrão de "não consigo processar arquivos".
// "bufferPreBaixado" é opcional: onMessagesUpsert já baixa a mídia UMA vez
// pra salvar em disco (painel de atendimento — ver mediaStorage.service.js)
// e repassa o mesmo buffer aqui, evitando baixar a mesma mídia duas vezes.
// Sem esse parâmetro, a função baixa por conta própria (mantém a função
// utilizável isoladamente).
async function analisarFotoRecebida(msg, bufferPreBaixado) {
  try {
    const conteudo = unwrapMessage(msg.message);
    const imageMessage = conteudo?.imageMessage;
    if (!imageMessage) return null;

    // "!== undefined" (não "||") de propósito: onMessagesUpsert já tentou
    // baixar a mídia pro storage e pode ter falhado (buffer null explícito,
    // não "nunca tentado") — nesse caso NÃO tenta baixar de novo aqui
    // (evitaria um retry silencioso mascarando a falha original). Só baixa
    // por conta própria quando ninguém baixou ainda (chamada isolada, sem
    // 2º argumento).
    const buffer = bufferPreBaixado !== undefined ? bufferPreBaixado : await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: conn.sock?.updateMediaMessage }
    );
    if (!buffer || !buffer.length) return null;

    const base64 = buffer.toString("base64");
    const mimeType = imageMessage.mimetype || "image/jpeg";

    return await analisarImagemPeca(base64, mimeType);
  } catch (err) {
    logger.warn(`[Visão-Foto] Falha ao baixar/analisar imagem: ${err.message}`);
    return null;
  }
}

// Análoga a analisarFotoRecebida, mas para nota de voz/áudio: baixa a mídia em
// memória e pede a transcrição via transcreverAudio() (Groq Whisper — ver
// ai.service.js). Retorna null em qualquer falha (áudio expirado, provedor
// indisponível, transcrição vazia), sinalizando pro chamador usar o fallback
// padrão de "não consigo processar arquivos".
// "bufferPreBaixado": mesma ideia de analisarFotoRecebida acima — evita
// baixar a mesma mídia duas vezes quando onMessagesUpsert já baixou pra
// salvar em disco.
async function analisarAudioRecebido(msg, bufferPreBaixado) {
  try {
    const conteudo = unwrapMessage(msg.message);
    const audioMessage = conteudo?.audioMessage;
    // BUG REAL (achado em teste ao vivo, 2026-07-20): áudio enviado pelo
    // menu de ANEXO do WhatsApp (não gravado na hora segurando o
    // microfone) chega como documentMessage, não audioMessage — mesmo
    // sendo um mp3/ogg de verdade. getMediaType() já reconhece isso e
    // classifica como "áudio" quando o mimetype do documento é audio/*;
    // aqui só precisamos usar o mimetype certo pra baixar/transcrever.
    const documentMessage = conteudo?.documentMessage;
    const mimeTypeDocumento = documentMessage?.mimetype;
    const ehAudioComoDocumento = !!mimeTypeDocumento && mimeTypeDocumento.startsWith("audio/");
    if (!audioMessage && !ehAudioComoDocumento) return null;

    // Ver comentário equivalente em analisarFotoRecebida sobre "!== undefined".
    const buffer = bufferPreBaixado !== undefined ? bufferPreBaixado : await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger, reuploadRequest: conn.sock?.updateMediaMessage }
    );
    if (!buffer || !buffer.length) return null;

    const mimeType = audioMessage?.mimetype || mimeTypeDocumento || "audio/ogg";

    return await transcreverAudio(buffer, mimeType);
  } catch (err) {
    logger.warn(`[Áudio-Transcrição] Falha ao baixar/transcrever áudio: ${err.message}`);
    return null;
  }
}

// Processa um texto DERIVADO de mídia (descrição de foto via visão, ou
// transcrição de áudio) pelo MESMO pipeline de uma mensagem digitada de
// verdade (mainFlow, sessão, histórico, socket) — nenhuma lógica de negócio
// duplicada pra extrair veículo/peça. "origem" é só pro log (ex: "foto",
// "áudio"). Devolve true quando o chamador deve `continue` (já tratou a
// mensagem, com sucesso ou com o fallback de erro do bot).
async function processarTextoDerivadoDeMidia(origem, { userId, contactName, sendTo, messageId, texto, mediaInfo }) {
  try {
    logger.info(`[MESSAGE_IN_${origem.toUpperCase()}] ${userId}: [${origem}] → "${texto}"`);

    sendTypingPresence(sendTo).catch(err =>
      logger.debug?.(`[Typing] não enviado para ${sendTo}: ${err.message}`)
    );

    const response = await withTimeout(
      conn.messageHandler({
        userId,
        contactName,
        message: texto,
        messageId,
        mediaPath:     mediaInfo?.mediaPath || null,
        mediaMimetype: mediaInfo?.mediaMimetype || null,
        mediaFilename: mediaInfo?.mediaFilename || null,
      }),
      MESSAGE_PROCESSING_TIMEOUT_MS,
      `processamento do bot (${origem})`
    );

    if (response) {
      await enviarComRetry(sendTo, response);
    }
    return true;
  } catch (err) {
    logger.error(`[BOT_PROCESSING_ERROR_${origem.toUpperCase()}] ${userId}: ${err.stack || err.message}`);
    try {
      await enviarComRetry(sendTo, BOT_PROCESSING_FALLBACK);
    } catch (sendErr) {
      logger.error(`[BOT_FALLBACK_SEND_ERROR] ${userId}: ${sendErr.message}`);
    }
    return true;
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

    // ── Download + persistência da mídia (se houver) ─────────────────────
    // Pedido do usuário (2026-07-20): "verifique por que arquivos de mídia
    // e áudio não aparecem no meu painel". Resposta: decisão deliberada de
    // uma correção anterior (task #116) — o bot nunca salvava o arquivo em
    // disco, só o fato de ter chegado. Agora baixa e salva UMA vez por
    // mensagem, independente de legenda ou de a IA conseguir analisar —
    // getMediaObject() (ao contrário de getMediaType(), usado mais abaixo
    // pro ROTEAMENTO do bot) não descarta imagem/vídeo com legenda, porque
    // aqui a decisão é só "salvar em disco", não "como responder". O
    // mesmo buffer é reaproveitado nas análises de visão/áudio logo
    // abaixo, pra não baixar a mesma mídia duas vezes.
    const conteudoRecebido = unwrapMessage(msg.message);
    const midiaBruta = getMediaObject(msg);
    let mediaBuffer = null;
    let mediaInfo = null;
    if (midiaBruta) {
      try {
        mediaBuffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger, reuploadRequest: conn.sock?.updateMediaMessage }
        );
      } catch (err) {
        logger.warn(`[Mídia] Falha ao baixar mídia recebida de ${userId}: ${err.message}`);
      }
      if (mediaBuffer && mediaBuffer.length) {
        mediaInfo = await salvarMidiaRecebida(mediaBuffer, midiaBruta.mimetype, messageId, {
          originalFilename: midiaBruta.filename || null,
        });
      }
    }

    // BUG REAL (achado em teste ao vivo, 2026-07-20): esta checagem de foto
    // rodava só dentro do bloco `if (!text)` abaixo — cliente que manda foto
    // COM legenda (ex: "vcs tem essa peça?") tinha só a legenda processada
    // como texto normal, e a imagem NUNCA era examinada, mesmo com visão
    // disponível. Roda ANTES do `if (!text)` de propósito, pra cobrir os
    // dois casos. Com legenda, combina legenda + descrição da imagem antes
    // de processar; sem legenda, usa só a descrição (comportamento já
    // existente, preservado).
    const imageMessageRecebida = conteudoRecebido?.imageMessage;
    if (imageMessageRecebida && suportaVisao()) {
      const descricao = await analisarFotoRecebida(msg, mediaBuffer);
      if (descricao) {
        const legenda = imageMessageRecebida.caption?.trim();
        const textoParaPipeline = legenda
          ? `${legenda}\n\n[Imagem enviada pelo cliente: ${descricao}]`
          : descricao;
        await processarTextoDerivadoDeMidia("foto", { userId, contactName, sendTo, messageId, texto: textoParaPipeline, mediaInfo });
        continue;
      }
      // descricao null (não é peça, provedor falhou, mídia expirada etc.) →
      // segue fluxo normal: com legenda, o texto dela é processado como
      // mensagem comum logo abaixo; sem legenda, cai no aviso padrão de
      // mídia não suportada dentro do `if (!text)`.
    }

    if (!text) {
      const tipoMidia = getMediaType(msg);

      // Nota de voz (gravada na hora, ou enviada como arquivo de áudio pelo
      // menu de anexo — ver getMediaType) + Groq configurada (independente
      // do AI_PROVIDER de chat — ver suportaAudio() em ai.service.js):
      // transcreve e processa o texto pelo pipeline normal, igual à foto.
      if (tipoMidia === "áudio" && suportaAudio()) {
        const transcricao = await analisarAudioRecebido(msg, mediaBuffer);
        if (transcricao) {
          await processarTextoDerivadoDeMidia("áudio", { userId, contactName, sendTo, messageId, texto: transcricao, mediaInfo });
          continue;
        }
        // transcricao null (sem chave, erro, áudio sem fala reconhecível etc.)
        // → segue pro aviso padrão de mídia não suportada, abaixo.
      }

      if (tipoMidia) {
        // BUG CORRIGIDO (usuário: "sinto que não está salvando todas as
        // conversas"): mídia sem legenda (foto, áudio, vídeo, sticker,
        // documento) caía direto no "continue" abaixo SEM nunca passar por
        // saveHistory — cliente manda foto de peça quebrada (comum numa
        // loja de autopeças), recebe o aviso automático, e a troca inteira
        // desaparecia do painel de Histórico, mesmo a mensagem tendo
        // chegado normalmente. Agora registra como o restante do fluxo:
        // "message" guarda um marcador do tipo de mídia, e (a partir da
        // task de storage acima) mediaInfo guarda o arquivo salvo em disco
        // de verdade, quando o download deu certo.
        // Concordância de gênero: só "imagem" é feminino ("sua imagem")
        // entre os tipos que chegam aqui — os demais ("áudio", "sticker",
        // "documento", "vídeo") são masculinos ("seu ...").
        const artigoMidia = tipoMidia === "imagem" ? "sua" : "seu";
        const avisoMidia =
          `⚠️ Recebi ${artigoMidia} ${tipoMidia}, mas ainda não consigo processar arquivos.\n\n` +
          `Por favor, descreva sua dúvida em *texto* e será um prazer ajudar! 😊\n\n` +
          `Digite *0* para ver o menu.`;

        try {
          await enviarComRetry(sendTo, avisoMidia);
        } catch (err) {
          logger.error(`Erro ao enviar aviso de mídia: ${err.message}`);
        }

        try {
          await saveHistory({
            userId,
            contactName,
            message:  `[${tipoMidia} recebido]`,
            response: avisoMidia,
            sector:   "midia_nao_suportada",
            messageId,
            mediaPath:     mediaInfo?.mediaPath || null,
            mediaMimetype: mediaInfo?.mediaMimetype || null,
            mediaFilename: mediaInfo?.mediaFilename || null,
          });
          emitEvent("nova_mensagem", {
            userId,
            contactName,
            message:  `[${tipoMidia} recebido]`,
            messageId,
            response: avisoMidia,
            sector:   "midia_nao_suportada",
            createdAt: new Date(),
            mediaPath:     mediaInfo?.mediaPath || null,
            mediaMimetype: mediaInfo?.mediaMimetype || null,
            mediaFilename: mediaInfo?.mediaFilename || null,
          });
        } catch (err) {
          logger.warn(`Erro ao salvar histórico de mídia para ${userId}: ${err.message}`);
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
        conn.messageHandler({
          userId,
          contactName,
          message: text,
          messageId,
          mediaPath:     mediaInfo?.mediaPath || null,
          mediaMimetype: mediaInfo?.mediaMimetype || null,
          mediaFilename: mediaInfo?.mediaFilename || null,
        }),
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
