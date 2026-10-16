const { getBotConfig, resolverBotOffEfetivo } = require("../services/botConfig.service");
const logger            = require("../utils/logger");
const { emitEvent }     = require("../services/socket.service");
const {
  setLidMapping,
  persistLidMappings,
  normalizeJid,
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
  isOutgoingEcho,
  parseMessageStatus
} = require("../whatsapp/message-utils");
const { isDuplicateContent, marcarMensagemProcessada, startDedupCleanup } = require("../whatsapp/dedup");
const { autoRegisterContact, contatoTemTagFuncionario, buscarNomeContatoReal } = require("../whatsapp/contacts");
const { saveHistory } = require("../services/history.service");
const { reopenTicketIfClosed } = require("../services/ticket.service");
const humanMode        = require("../services/humanMode.service");
const { transcreverAudio, suportaAudio, analisarImagemPeca, suportaVisao } = require("../services/ai.service");
const { salvarMidiaRecebida } = require("../services/mediaStorage.service");
const { updateSession } = require("../services/session.service");
const { scheduleFragment } = require("../services/messageFragment.service");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const pino   = require("pino");
const path   = require("path");
const fs     = require("fs");

// Logger que a Baileys espera (interface pino: trace/debug/info/warn/error +
// .child). Antes era criado inline em cada chamada — e em downloadMediaMessage
// passávamos o NOSSO logger, que não tem .debug/.child: a Baileys chama
// `logger.info({ key }, "...")` com objeto, e nosso info(msg) produzia
// "[object Object]". Um único pino compartilhado resolve os dois casos.
const baileysLogger = pino({ level: "fatal" });

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
  lastQr:              null, // último QR pendente (até conectar) — permite buscar via API
  ownNumber:           null, // dígitos do próprio número (sem @s.whatsapp.net) — usado pelo watchdog
  watchdogFails:       0     // falhas consecutivas da checagem ativa do watchdog (ver watchdogTick)
};

const MAX_RECONNECT_DELAY_MS = 30_000;
// PEDIDO DO USUÁRIO (2026-09-23): "as vezes meu whatsapp cai e fica uma queda
// fantasma onde eu so consigo saber porque mais nenhuma notificação chega" —
// ver watchdogTick() mais abaixo para o diagnóstico completo (o painel só
// detectava desconexão via evento passivo do Baileys, que pode nunca disparar
// numa queda de rede "silenciosa").
const WATCHDOG_INTERVAL_MS = 90_000; // intervalo entre checagens ativas
const WATCHDOG_TIMEOUT_MS  = 15_000; // timeout de cada checagem individual
const WATCHDOG_MAX_FAILS   = 2;      // falhas seguidas exigidas antes de forçar reconexão (~3min no total)
const MESSAGE_PROCESSING_TIMEOUT_MS = Number(process.env.BOT_MESSAGE_TIMEOUT_MS || 45_000);
const BOT_PROCESSING_FALLBACK =
  process.env.BOT_PROCESSING_FALLBACK ||
  "⚠️ Estou com uma instabilidade momentânea para processar sua mensagem. Tente novamente em instantes ou aguarde um atendente.";

// Modo de teste (pedido do usuário, 2026-07-24) — números (só dígitos,
// separados por vírgula) que continuam recebendo resposta do bot mesmo com
// "ativo=false" no painel. Mesmo formato/definição de TEST_NUMBERS em
// src/config/env.js, mas lido direto de process.env AQUI em vez de
// `require("./env")`: env.js valida TODAS as variáveis obrigatórias do
// projeto (API_TOKEN, DB_PASSWORD etc.) e derruba o processo se alguma
// faltar — ótimo pro server.js real (primeiro módulo importado), mas
// pesado demais como dependência de config/whatsapp.js, que os testes
// (tests/whatsapp.*.test.js) importam isoladamente, mockando só banco/
// socket/Baileys. Mesmo padrão já usado em src/database/postgres.js (lê
// process.env direto, com fallback, sem depender do validador).
const TEST_NUMBERS = String(process.env.TEST_NUMBERS || "")
  .split(",")
  .map(n => n.replace(/\D/g, ""))
  .filter(Boolean);

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
      const sent = await currentSock.sendMessage(userId, { text: response });
      // Garante que o flag fica sincronizado
      if (!conn.isWhatsAppConnected) conn.isWhatsAppConnected = true;
      logger.info(`[WhatsApp] ✓ Resposta enviada. Tentativa ${i + 1}`);
      // Registra o id no dedup — mesmo motivo de sendMessage()/sendMedia():
      // sem isso, o eco fromMe da PRÓPRIA resposta do bot seria confundido
      // com mensagem enviada pelo celular (ver isOutgoingEcho em
      // onMessagesUpsert) e duplicaria a linha no histórico do painel.
      if (sent?.key?.id) { try { await marcarMensagemProcessada(sent.key.id); } catch (_) {} }
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

// 2026-10-09 (auditoria de performance — um dos travamentos que derrubavam
// o bot): o WhatsApp manda a lista INTEIRA de contatos em `contacts.set` a
// cada conexão E a cada reconexão. A versão anterior percorria tudo de forma
// síncrona chamando setLidMapping, que por contato novo fazia um
// `logger.info` (na época, appendFileSync bloqueante) + um `pool.query` SEM
// await. Com 2.000 contatos: 2.000 escritas síncronas em disco num laço sem
// nenhuma cessão do event loop, e até 2.000 queries concorrentes num pool de
// 20 — com `connectionTimeoutMillis: 15000`, qualquer outra parte do sistema
// que precisasse do banco nesse meio tempo (authSession do painel, tick do
// agendador) estourava com "Connection terminated due to connection timeout".
// E o event loop travado derrubava o keepalive do WhatsApp (código 408), que
// reconectava, que mandava `contacts.set` de novo: o ciclo que se auto-alimenta.
//
// Agora: só memória dentro do laço (persist/log desligados), cessão do event
// loop a cada 200 contatos, e UM UPSERT em lote no fim (persistLidMappings),
// aguardado — o pool nunca vê mais de uma query nossa por vez.
async function processContacts(contacts, source) {
  const lista = Array.isArray(contacts) ? contacts : [];
  const novos = [];

  for (let i = 0; i < lista.length; i += 1) {
    const c = lista[i];
    if (!c) continue;

    if (c.lid && c.id && !c.id.includes("@lid")) {
      if (setLidMapping(c.lid, c.id, source, { persist: false, log: false })) {
        novos.push([normalizeJid(c.lid), normalizeJid(c.id)]);
      }
    }
    if (c.id && c.id.includes("@lid") && (c.phone || c.number)) {
      const phone = (c.phone || c.number).replace(/\D/g, "");
      const jid = `${phone}@s.whatsapp.net`;
      if (setLidMapping(c.id, jid, `${source}/phone`, { persist: false, log: false })) {
        novos.push([normalizeJid(c.id), normalizeJid(jid)]);
      }
    }

    // Devolve o event loop periodicamente: com a lista inteira de contatos,
    // um laço sem cessão é o que derruba o keepalive do WhatsApp.
    if (i > 0 && i % 200 === 0) await new Promise(r => setImmediate(r));
  }

  logger.info(
    `[${source}] ${lista.length} contatos | ${novos.length} mapeamento(s) novo(s) | ` +
    `mapa total: ${getLidMapStats().lidToJid} entradas`
  );

  await persistLidMappings(novos);
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

      iniciarReconexaoComBackoff();
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
    conn.watchdogFails       = 0;    // conexão nova/saudável — zera contador do watchdog
    logger.info("[WhatsApp] ✓ Conectado com sucesso!");
    emitEvent("whatsapp_status", { status: "connected" });
  }
}

// Dispara a MESMA sequência de reconexão-com-backoff usada pelo handler de
// connection.update "close" (getReconnectDelay + limparSocketAntigo +
// connectWhatsApp) — reaproveitada aqui pelo watchdog para não duplicar essa
// lógica. `conn.reconnecting` já protege contra as duas fontes (evento real
// do Baileys e watchdog) dispararem reconexão ao mesmo tempo.
function iniciarReconexaoComBackoff() {
  if (conn.reconnecting) return;

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
}

// PEDIDO DO USUÁRIO (2026-09-23): "as vezes meu whatsapp cai e fica uma queda
// fantasma onde eu so consigo saber porque mais nenhuma notificação chega" —
// até este fix, conn.isWhatsAppConnected só virava false quando o Baileys
// disparava connection.update com connection==="close". Em certas quedas de
// rede (wifi instável, NAT que derruba a sessão sem mandar RST/FIN de
// verdade — bem comum em rede residencial/celular) o WebSocket fica preso
// "aberto": nada mais chega nem sai, mas esse evento nunca dispara, então o
// painel continuava mostrando "Conectado" indefinidamente — o usuário só
// percebia a queda na prática (WhatsApp parava de notificar).
//
// Watchdog ATIVO: a cada WATCHDOG_INTERVAL_MS, se o estado interno diz
// "conectado", faz uma checagem real de ida-e-volta contra o WhatsApp
// (onWhatsApp() do próprio número — mesma chamada já usada em sendMessage/
// sendMedia para validar destinatário, aqui reaproveitada só para confirmar
// que o socket ainda troca dados de verdade com o servidor) com timeout
// curto. WATCHDOG_MAX_FAILS falhas SEGUIDAS (~3min no total, não uma única
// falha isolada — evita reconectar por causa de um soluço passageiro) faz o
// watchdog tratar como desconexão de verdade: emite o mesmo evento que uma
// queda real dispararia e entra no mesmo fluxo de reconexão com backoff.
async function watchdogTick() {
  if (!conn.isWhatsAppConnected || !conn.sock || conn.reconnecting) return;
  if (!conn.ownNumber) return; // ainda não temos o próprio número salvo — pula esta rodada

  try {
    await withTimeout(conn.sock.onWhatsApp(conn.ownNumber), WATCHDOG_TIMEOUT_MS, "watchdog de conexão");
    conn.watchdogFails = 0;
  } catch (err) {
    conn.watchdogFails += 1;
    logger.warn(`[Watchdog] Checagem de conexão falhou (${conn.watchdogFails}/${WATCHDOG_MAX_FAILS}): ${err.message}`);

    if (conn.watchdogFails >= WATCHDOG_MAX_FAILS) {
      logger.error("[Watchdog] Conexão parece morta (sem resposta do WhatsApp) — forçando reconexão.");
      conn.watchdogFails = 0;
      conn.isWhatsAppConnected = false;
      emitEvent("whatsapp_status", { status: "disconnected", code: "watchdog_timeout" });
      iniciarReconexaoComBackoff();
    }
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

// REMOVIDO (2026-07-29, pedido do usuário): analisarFotoRecebida() chamava
// IA de visão (analisarImagemPeca) pra descrever a foto do cliente — custo e
// confiabilidade. Ver bloco de tratamento de imageMessage em
// onMessagesUpsert (mais abaixo) pra a nova regra 100% determinística
// (legenda vira texto normal; sem legenda, pergunta se quer orçamento após
// 3s). analisarImagemPeca()/suportaVisao() continuam existindo em
// ai.service.js (não removidos de lá — só pararam de ser chamados aqui),
// caso um dia façam sentido de novo pra outro uso.

// Análoga à antiga analisarFotoRecebida, mas para nota de voz/áudio: baixa a mídia em
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
      { logger: baileysLogger, reuploadRequest: conn.sock?.updateMediaMessage }
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
async function processarTextoDerivadoDeMidia(origem, { userId, contactName, sendTo, messageId, texto, mediaInfo, isNumeroTeste = false, isFuncionario = false }) {
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
        // Modo de teste + bloqueio "Funcionário" (2026-07-24) — ver
        // resolverBotOffEfetivo() em botConfig.service.js. Repassado aqui
        // porque processMessage() em message.service.js é quem de fato
        // decide se roda mainFlow (IA/ERP), re-buscando o botConfig fresco.
        isNumeroTeste,
        isFuncionario,
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

// PEDIDO DO USUÁRIO (2026-07-27): "mensagens enviadas pelo meu celular com o
// número do bot não aparecem no chat do painel". isValidUserMessage()
// descarta TODA mensagem fromMe (painel, bot E celular, sem distinguir).
// Painel e bot já salvam sua própria resposta em saveHistory() no momento do
// envio (sendManualMessage, processMessage) — e agora também registram o id
// em marcarMensagemProcessada() na hora de enviar (ver sendMessage/sendMedia/
// enviarComRetry acima), então o eco fromMe dessas duas origens nunca chega
// até aqui (é descartado antes, no dedup do topo de onMessagesUpsert). Uma
// mensagem fromMe que sobrevive até isOutgoingEcho() só pode ter vindo do
// WhatsApp do celular diretamente — nunca foi salva em lugar nenhum até
// agora. Trata como se fosse um envio manual: salva no histórico (sector
// "manual", igual sendManualMessage), emite pro painel e pausa o bot pro
// cliente (mesmo efeito de o atendente responder pelo painel).
async function handleOutgoingFromPhone(msg) {
  const jid = msg.key.remoteJid;
  const messageId = msg.key.id;
  const text = getTextMessage(msg).trim();
  const midiaBruta = getMediaObject(msg);

  if (!text && !midiaBruta) return; // nada exibível (ex: reação, recibo de leitura)

  let userId = jid;
  if (jid.includes("@lid")) {
    const resolvedFromMap = resolveLid(jid);
    if (resolvedFromMap) {
      userId = resolvedFromMap;
    } else if (msg.key.senderPn) {
      const rawPn = String(msg.key.senderPn).replace(/[^\d]/g, "");
      userId = `${rawPn}@s.whatsapp.net`;
      setLidMapping(jid, userId, "senderPn");
    }
  }

  let contactName = "";
  try {
    contactName = (await buscarNomeContatoReal(userId)) || "";
  } catch (_) {}

  let mediaInfo = {};
  if (midiaBruta) {
    try {
      const mediaBuffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: baileysLogger, reuploadRequest: conn.sock?.updateMediaMessage }
      );
      if (mediaBuffer && mediaBuffer.length) {
        mediaInfo = await salvarMidiaRecebida(mediaBuffer, midiaBruta.mimetype, messageId, {
          originalFilename: midiaBruta.filename || null,
        });
      }
    } catch (err) {
      logger.warn(`[Celular] Falha ao baixar mídia enviada pelo celular para ${userId}: ${err.message}`);
    }
  }

  const respostaFinal = text || (mediaInfo.mediaPath ? "[arquivo enviado]" : "");

  try {
    await saveHistory({
      userId,
      contactName,
      message: null,
      response: respostaFinal,
      sector: "manual",
      messageId,
      status: "sent",
      ...mediaInfo,
    });
  } catch (err) {
    logger.warn(`[Celular] Falha ao salvar histórico de mensagem enviada pelo celular: ${err.message}`);
  }

  try {
    emitEvent("nova_mensagem", {
      userId,
      contactName,
      message: null,
      response: respostaFinal,
      messageId,
      sector: "manual",
      createdAt: new Date(),
      ...mediaInfo,
    });
  } catch (err) {
    logger.warn(`[Celular] Falha ao emitir evento pro painel: ${err.message}`);
  }

  // Mesmo efeito de sendManualMessage: atendente (agora pelo celular) está
  // respondendo diretamente — pausa o bot pra esse cliente.
  humanMode.ativar(userId, { agentName: "Celular" });

  // PEDIDO DO USUÁRIO (2026-10-16): resposta dada pelo celular deve contar como
  // atendimento aceito no painel — senão o ticket seguia em "Pendentes" mesmo
  // com o cliente já sendo atendido. Atribui ao atendente fixo configurado em
  // ATENDENTE_CELULAR_USUARIO (login; padrão "atendente04", o Rafael). Mesmo
  // caminho da resposta manual pelo painel: reaproveita ticket ativo (sem
  // roubar de quem já assumiu), reabre fechado ou cria um novo. Best-effort.
  try {
    const usuario = process.env.ATENDENTE_CELULAR_USUARIO || "atendente04";
    const atendente = await require("../repositories/user.repository").findByUsername(usuario);
    if (atendente && atendente.ativo) {
      await require("../controllers/message.controller").ensureTicketForManualReply(
        userId,
        { id: atendente.id, nome: atendente.nome, usuario: atendente.usuario },
        contactName
      );
    } else {
      logger.warn(`[Celular] Atendente "${usuario}" não encontrado/ativo — atendimento não foi aceito automaticamente.`);
    }
  } catch (err) {
    logger.warn(`[Celular] Falha ao aceitar atendimento automaticamente: ${err.message}`);
  }
}

// Handler de messages.upsert: pipeline completo de uma mensagem recebida —
// dedup, resolução de LID, auto-registro de contato, checagem de bot
// ativo/inativo, tratamento de mídia sem texto, dedup de conteúdo e,
// finalmente, chamada ao processMessage (messageHandler) com timeout e
// fallback amigável em caso de erro.
async function onMessagesUpsert({ messages, type }) {
  for (const msg of messages) {
    const jid = msg.key?.remoteJid;

    // 2026-10-09 (auditoria de performance): a ordem aqui estava invertida —
    // marcarMensagemProcessada (um INSERT no banco) rodava ANTES do filtro,
    // então toda mensagem de grupo e todo status@broadcast pagava uma ida ao
    // Postgres pra ser descartado na linha seguinte. No replay de uma
    // reconexão (o WhatsApp reentrega o backlog offline inteiro, com
    // type="append", que isValidUserMessage descarta) isso virava centenas de
    // INSERTs inúteis + uma linha de log síncrona cada, num pool já saturado.
    // Agora o descarte é feito primeiro, sem tocar em banco nem em disco.
    const ehValida = isValidUserMessage(msg, type);
    const ehEco    = isOutgoingEcho(msg, type);

    if (!ehValida && !ehEco) {
      if (!msg.key?.fromMe) logger.debug?.(`Mensagem ignorada | type=${type} | jid=${jid}`);
      continue;
    }

    const messageId = msg.key?.id;

    // MELHORIA: deduplicação com persistência no banco
    if (await marcarMensagemProcessada(messageId)) {
      logger.debug?.("Duplicada ignorada");
      continue;
    }

    if (!ehValida) {
      // Sobrou o eco de mensagem enviada pelo próprio celular.
      try {
        await handleOutgoingFromPhone(msg);
      } catch (err) {
        logger.warn(`[Celular] Erro ao processar mensagem enviada pelo celular: ${err.message}`);
      }
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

    // MODO DE TESTE + BLOQUEIO "FUNCIONÁRIO" (pedido do usuário, 2026-07-24):
    // resolvidos aqui, o mais cedo possível dentro do handler — antes de
    // qualquer análise de imagem/áudio por IA logo abaixo, e antes do texto
    // sequer chegar em processMessage (mainFlow/IA/ERP). Assim um contato
    // bloqueado nunca gera custo de IA nem chega a ser processado.
    // Prioridade da regra: tag "Funcionário" > número de teste > ativo
    // normal do painel — ver resolverBotOffEfetivo() em botConfig.service.js
    // (fonte única da regra, reaplicada também dentro de processMessage).
    const isFuncionario = await contatoTemTagFuncionario(userId);
    const numeroDigits = String(userId || "").replace(/@(s\.whatsapp\.net|lid)$/i, "").replace(/\D/g, "");
    const isNumeroTeste = TEST_NUMBERS.includes(numeroDigits);

    const text = getTextMessage(msg).trim();

    // BUG CORRIGIDO (reportado pelo usuário, 2026-07-23): esse `continue`
    // saía do loop e pulava a mensagem POR COMPLETO — antes até de baixar
    // mídia, salvar histórico ou emitir pro painel. Com o bot desligado
    // (Configurações > Bot ativo = Desativado), mensagens novas simplesmente
    // sumiam sem notificação nenhuma, e mensagens de clientes com ticket já
    // fechado nunca reabriam o atendimento (reopenTicketIfClosed vive dentro
    // de processMessage/message.service.js, nunca alcançado). Mesma causa
    // raiz do bug já corrigido em message.service.js (ver BUG CORRIGIDO lá) —
    // aquele conserto sozinho não bastava porque este segundo gate, aqui em
    // cima, ainda impedia a mensagem de sequer chegar em processMessage.
    // Agora `botOff` só desliga as respostas automáticas mais abaixo (aviso
    // de mídia não suportada, "digitando...") — a mensagem sempre segue o
    // fluxo normal até o `conn.messageHandler(...)` (processMessage), que já
    // sabe lidar com bot desligado (reabre ticket, emite pro painel, salva
    // histórico, sem resposta automática).
    const botConfig = await getBotConfigCached();
    const botOff = resolverBotOffEfetivo({
      ativoFalse: botConfig.ativo === false || botConfig.ativo === "false",
      isNumeroTeste,
      isFuncionario,
    });
    if (isFuncionario) {
      logger.info(`[Funcionário] ${userId} tem a tag "Funcionário" — bot não responde automaticamente (só atendimento manual pelo painel).`);
    } else if (botOff) {
      logger.warn(`Bot desativado — mensagem de ${userId} será registrada normalmente, sem resposta automática.`);
    } else if (isNumeroTeste && botConfig.ativo === false) {
      logger.info(`[Modo de teste] ${userId} é número de teste autorizado — bot segue ativo mesmo com ativo=false no painel.`);
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
          { logger: baileysLogger, reuploadRequest: conn.sock?.updateMediaMessage }
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

    // PEDIDO DO USUÁRIO (2026-07-29): parar de usar IA de visão pra
    // interpretar foto de cliente — custo e confiabilidade (a IA às vezes
    // "via" coisas erradas ou a chamada falhava/demorava).
    //   • Foto COM legenda → o cliente já disse o que é em texto — processa
    //     só a legenda, no MESMO pipeline de sempre (mainFlow/vendas/IA de
    //     TEXTO), exatamente como se tivesse digitado aquilo sem anexar
    //     nada. Nunca tenta "ver" a imagem.
    //   • Foto SEM legenda → espera 3s (pedido do usuário — resposta
    //     instantânea a uma foto muda soa "robótica demais") e pergunta se
    //     o cliente quer registrar um orçamento, reaproveitando o MESMO
    //     intercept de confirmação ("aguardandoConfirmacaoOrcamento", já
    //     usado em main.flow.js pra perguntas de disponibilidade da IA) —
    //     respondendo "sim" o cliente cai no fluxo normal de vendas (pede
    //     nome/veículo/peça a partir daí).
    // REATIVAÇÃO PARCIAL DA VISÃO (2026-07-29, mesmo dia, pedido do
    // usuário): "caso o bot consiga reconhecer a peça responda de um jeito
    // melhor, caso não, pergunte se deseja orçamento mesmo sem descrição" —
    // mas só usando a IA de visão em fotos que NÃO pareçam tiradas com
    // celular (ver PASSO 2 do PROMPT_VISAO em ai.service.js: a própria IA se
    // autoavalia e devolve null/"FOTO_INCERTA" pra foto real de peça usada
    // em oficina, só arrisca identificar foto de catálogo/produto). Roda em
    // paralelo com os 3s de espera (não soma delay extra além do maior dos
    // dois) — só quando vai mesmo responder automaticamente (economiza
    // chamada de IA se bot desligado/humano assumiu).
    // Roda ANTES do `if (!text)` de propósito, pra cobrir os dois casos
    // (foto com legenda tem `text` preenchido com a legenda).
    const imageMessageRecebida = conteudoRecebido?.imageMessage;
    if (!isFuncionario && imageMessageRecebida) {
      const legenda = imageMessageRecebida.caption?.trim();

      if (legenda) {
        await processarTextoDerivadoDeMidia("foto", { userId, contactName, sendTo, messageId, texto: legenda, mediaInfo, isNumeroTeste, isFuncionario });
        continue;
      }

      // Mesma regra do aviso de mídia não suportada (mais abaixo): nunca
      // responde por cima de humano/bot desligado, e ainda reabre ticket
      // fechado (cliente com atendimento encerrado que manda só uma foto
      // muda volta pra Pendentes normalmente).
      const semRespostaAutomaticaFoto = botOff || humanMode.estaAtivo(userId);

      try { await reopenTicketIfClosed(userId); } catch (e) { logger.warn(`Erro ao reabrir ticket (foto sem legenda): ${e.message}`); }

      let perguntaOrcamento =
        "📷 Recebi sua foto!\n\n" +
        "Deseja que eu já registre um orçamento pra essa peça? Digite *sim* para confirmar ou *0* para voltar ao menu.";

      if (!semRespostaAutomaticaFoto) {
        const visaoDisponivel = suportaVisao() && mediaBuffer && mediaBuffer.length;
        if (!visaoDisponivel) {
          logger.info(`[Foto] Visão não tentada para ${userId} (suportaVisao=${suportaVisao()}, mediaBuffer=${!!(mediaBuffer && mediaBuffer.length)}) — pergunta genérica.`);
        }
        const analiseVisaoPromise = visaoDisponivel
          ? analisarImagemPeca(mediaBuffer.toString("base64"), midiaBruta.mimetype).catch(err => {
              logger.warn(`Erro ao analisar foto (visão) de ${userId}: ${err.message}`);
              return null;
            })
          : Promise.resolve(null);

        // Espera pelo maior entre os 3s (naturalidade da resposta) e o tempo
        // que a análise de visão levar — nunca soma os dois delays.
        const [, descricaoReconhecida] = await Promise.all([
          new Promise(resolve => setTimeout(resolve, 3000)),
          analiseVisaoPromise,
        ]);

        if (descricaoReconhecida) {
          perguntaOrcamento =
            `📷 Vi que é *${descricaoReconhecida}*! 😊\n\n` +
            "Deseja que eu já registre um orçamento pra essa peça? Digite *sim* para confirmar ou *0* para voltar ao menu.";
        }

        try {
          await enviarComRetry(sendTo, perguntaOrcamento);
          // BUG CORRIGIDO (Issue #15): quando a visão reconhece a peça, o
          // texto já mostrado ao cliente ("Vi que é X!") nunca era salvo na
          // sessão — só a flag aguardandoConfirmacaoOrcamento. Resultado:
          // cliente confirma "sim" e o bot pergunta o veículo do zero (main.
          // flow.js só pula essa pergunta quando session.veiculoSugerido já
          // existe), mesmo tendo acabado de exibir o veículo exato. Não há
          // extração separada de veículo/peça nesse caminho (diferente do
          // texto/legenda, que passa pelo pipeline normal de IA) — grava o
          // mesmo texto completo em ambos os campos; _finalizarOrcamento
          // (vendas.flow.js) já evita duplicar a frase na descrição do
          // ticket quando os dois campos vêm idênticos.
          await updateSession(userId, {
            aguardandoConfirmacaoOrcamento: true,
            ...(descricaoReconhecida ? {
              veiculoSugerido: descricaoReconhecida,
              produtoSugerido: descricaoReconhecida,
            } : {}),
          });
        } catch (err) {
          logger.error(`Erro ao enviar pergunta de orçamento (foto sem legenda) para ${userId}: ${err.message}`);
        }
      }

      const setorFoto = semRespostaAutomaticaFoto
        ? (botOff ? "bot_desligado" : "humano")
        : "foto_sem_legenda_aguardando_confirmacao";
      const respostaFoto = semRespostaAutomaticaFoto ? null : perguntaOrcamento;

      try {
        await saveHistory({
          userId,
          contactName,
          message:  "[imagem recebida]",
          response: respostaFoto,
          sector:   setorFoto,
          messageId,
          mediaPath:     mediaInfo?.mediaPath || null,
          mediaMimetype: mediaInfo?.mediaMimetype || null,
          mediaFilename: mediaInfo?.mediaFilename || null,
        });
        emitEvent("nova_mensagem", {
          userId,
          contactName,
          message:  "[imagem recebida]",
          messageId,
          response: respostaFoto,
          sector:   setorFoto,
          createdAt: new Date(),
          mediaPath:     mediaInfo?.mediaPath || null,
          mediaMimetype: mediaInfo?.mediaMimetype || null,
          mediaFilename: mediaInfo?.mediaFilename || null,
        });
      } catch (err) {
        logger.warn(`Erro ao salvar histórico de foto sem legenda para ${userId}: ${err.message}`);
      }

      continue;
    }

    if (!text) {
      const tipoMidia = getMediaType(msg);

      // Nota de voz (gravada na hora, ou enviada como arquivo de áudio pelo
      // menu de anexo — ver getMediaType) + Groq configurada (independente
      // do AI_PROVIDER de chat — ver suportaAudio() em ai.service.js):
      // transcreve e processa o texto pelo pipeline normal, igual à foto.
      if (!isFuncionario && tipoMidia === "áudio" && suportaAudio()) {
        const transcricao = await analisarAudioRecebido(msg, mediaBuffer);
        if (transcricao) {
          await processarTextoDerivadoDeMidia("áudio", { userId, contactName, sendTo, messageId, texto: transcricao, mediaInfo, isNumeroTeste, isFuncionario });
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

        // BUG CORRIGIDO (2026-07-23): esse aviso automático nunca checava
        // humanMode nem bot desligado — respondia por cima até de um
        // atendente que já tinha assumido o ticket (reproduzido em produção,
        // ticket #2026-0089: cliente mandou imagem DEPOIS do atendente
        // assumir, e saiu "não consigo processar arquivos" mesmo assim), e
        // mandava a mesma mensagem automática mesmo com o bot desligado no
        // painel. Mesma regra do resto do pipeline agora (ver
        // message.service.js): só envia resposta automática quando o bot
        // está ligado E ninguém assumiu — a mensagem em si sempre é salva/
        // emitida pro painel, para não sumir do histórico.
        const semRespostaAutomatica = botOff || humanMode.estaAtivo(userId);

        // PEDIDO DO USUÁRIO (2026-07-27): sticker é quase sempre uma reação
        // (like, risada, "positivo") — mesma categoria de emoji/reação de
        // despedida já tratada em pareceEncerramentoPosAvaliacao
        // (ticket.service.js). Responder "não consigo processar arquivos,
        // descreva em texto" pra uma reação é estranho e alimenta parte dos
        // problemas de menu/reabertura vistos em produção. Sticker nunca
        // recebe o aviso automático (mesmo com o bot ligado) — mas ainda é
        // salvo no histórico normalmente, pra não sumir do painel.
        //
        // PEDIDO DO USUÁRIO (2ª parte, mesma conversa): sticker também NÃO
        // reabre um ticket fechado — diferente dos outros tipos de mídia
        // (foto/áudio/vídeo/documento), que continuam reabrindo normalmente
        // logo abaixo (BUG CORRIGIDO 2026-07-23: aviso de mídia não chamava
        // reopenTicketIfClosed, cliente com ticket fechado mandando só uma
        // foto ficava "preso" sem reaparecer em Pendentes — isso continua
        // valendo pra tudo, EXCETO sticker).
        const ehSticker = tipoMidia === "sticker";

        if (!ehSticker) {
          try { await reopenTicketIfClosed(userId); } catch (e) { logger.warn(`Erro ao reabrir ticket (mídia): ${e.message}`); }
        }

        if (!semRespostaAutomatica && !ehSticker) {
          try {
            await enviarComRetry(sendTo, avisoMidia);
          } catch (err) {
            logger.error(`Erro ao enviar aviso de mídia: ${err.message}`);
          }
        }

        const respostaFinal = (semRespostaAutomatica || ehSticker) ? null : avisoMidia;
        const setorFinal = semRespostaAutomatica
          ? (isFuncionario ? "funcionario_bloqueado" : (botOff ? "bot_desligado" : "humano"))
          : (ehSticker ? "sticker_sem_resposta" : "midia_nao_suportada");

        try {
          await saveHistory({
            userId,
            contactName,
            message:  `[${tipoMidia} recebido]`,
            response: respostaFinal,
            sector:   setorFinal,
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
            response: respostaFinal,
            sector:   setorFinal,
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

    logger.info(`[MESSAGE_IN] ${userId}: ${text}`);

    // UX: mostra "digitando..." antes de processar IA/fluxo quando possível.
    sendTypingPresence(sendTo).catch(err =>
      logger.debug?.(`[Typing] não enviado para ${sendTo}: ${err.message}`)
    );

    // BUG CORRIGIDO (item #4 da análise de conversas — fragmentação):
    // mensagem de texto puro (sem mídia — mediaInfo é preenchido só quando
    // há foto/vídeo/áudio/documento anexado, ver acima) passa por
    // scheduleFragment() antes de chegar no bot, pra juntar fragmentos
    // rápidos do mesmo cliente numa só chamada. Mensagem com mídia
    // (imagem+legenda sem análise de visão disponível, por exemplo) segue
    // direto, sem essa espera — ver messageFragment.service.js.
    if (!mediaInfo) {
      scheduleFragment(userId, { text, messageId }, async ({ text: textoFinal, messageId: messageIdFinal }) => {
        try {
          const response = await withTimeout(
            conn.messageHandler({
              userId,
              contactName,
              message: textoFinal,
              messageId: messageIdFinal,
              mediaPath: null,
              mediaMimetype: null,
              mediaFilename: null,
              isNumeroTeste,
              isFuncionario,
            }),
            MESSAGE_PROCESSING_TIMEOUT_MS,
            "processamento do bot"
          );

          // Retorno vazio é normal quando atendimento humano está ativo.
          if (!response) {
            logger.debug?.(`[MESSAGE_NO_BOT_RESPONSE] ${userId}`);
            return;
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
      });
      continue;
    }

    try {
      const response = await withTimeout(
        conn.messageHandler({
          userId,
          contactName,
          message: text,
          messageId,
          mediaPath:     mediaInfo?.mediaPath || null,
          mediaMimetype: mediaInfo?.mediaMimetype || null,
          mediaFilename: mediaInfo?.mediaFilename || null,
          isNumeroTeste,
          isFuncionario,
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

    // Salva o próprio número (só dígitos) pra o watchdog usar em onWhatsApp()
    // — só existe depois do primeiro pareamento (state.creds.me), então fica
    // null até lá (watchdogTick já trata esse caso pulando a checagem).
    if (state.creds?.me?.id) {
      conn.ownNumber = state.creds.me.id.split(":")[0].split("@")[0];
    }
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
    // 2026-10-09 (auditoria): auth state envolvido em makeCacheableSignalKeyStore.
    // useMultiFileAuthState guarda cada chave de sessão Signal num arquivo
    // separado, então SEM esse cache cada decifragem de mensagem vira
    // readFile+JSON.parse (e writeFile+JSON.stringify ao avançar o ratchet),
    // serializados por mutex de arquivo. A própria Baileys desaconselha o uso
    // cru em produção. Quando o event loop travava, esses awaits de disco
    // ficavam pendurados, a decifragem estourava, o Baileys pedia reenvio
    // (sendRetryRequest) e a mesma mensagem era redecifrada sobre um ratchet
    // já avançado → "MessageCounterError: Key used already or never filled"
    // (863 por minuto no log de 01/10).
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, baileysLogger)
    },
    logger:                  baileysLogger,
    printQRInTerminal:       false,
    syncFullHistory:         false,
    markOnlineOnConnect:     false,
    // Era 10000 (o padrão da Baileys é 30000). O keepalive precisa do event
    // loop pra enviar E pra processar a resposta: com 10s, qualquer travada
    // de ~10-20s virava desconexão com código 408 → reconexão → contacts.set
    // inteiro de volta → travada de novo. Com 30s a mesma lentidão é tolerada
    // em vez de virar reconexão.
    keepAliveIntervalMs:     Number(process.env.WA_KEEPALIVE_MS || 30000),
    connectTimeoutMs:        60000,
    // Era 60000. É o timeout das consultas IQ (inclusive profilePictureUrl):
    // com o socket degradado, /api/contacts/photo ficava EXATAMENTE 60s
    // pendurado por candidato antes de desistir. 20s é de sobra.
    defaultQueryTimeoutMs:   Number(process.env.WA_QUERY_TIMEOUT_MS || 20000),
    emitOwnEvents:           false,
    // Era 250ms — martelava o retry e multiplicava a redecifragem.
    retryRequestDelayMs:     1000,
    // Grupo/newsletter/status são descartados logo depois por
    // isValidUserMessage: ignorando aqui, o Baileys nem gasta CPU decifrando.
    shouldIgnoreJid: (jid) => {
      const j = String(jid || "");
      return !j
        || j.endsWith("@g.us")
        || j.endsWith("@newsletter")
        || j.endsWith("@broadcast")
        || j === "status@broadcast";
    }
  });

  conn.sock.ev.on("creds.update", saveCreds);
  conn.sock.ev.on("contacts.upsert", contacts =>
    processContacts(contacts, "contacts.upsert").catch(err =>
      logger.warn(`[contacts.upsert] ${err.message}`)));
  conn.sock.ev.on("contacts.set", ({ contacts }) =>
    processContacts(contacts || [], "contacts.set").catch(err =>
      logger.warn(`[contacts.set] ${err.message}`)));
  conn.sock.ev.on("connection.update", onConnectionUpdate);
  conn.sock.ev.on("presence.update", onPresenceUpdate);
  conn.sock.ev.on("messages.update", onMessagesUpdate);
  conn.sock.ev.on("messages.upsert", onMessagesUpsert);
}


// 2026-10-09 (auditoria — o "GET /api/contacts/photo ... 204 - 64916ms" do log):
// profilePictureUrl é uma consulta IQ pelo websocket e obedecia ao
// defaultQueryTimeoutMs, que era 60000. Com o socket degradado a resposta
// nunca vinha, e como os candidatos eram percorridos em SEQUÊNCIA (até 9,
// tipicamente 3-4 distintos), um único avatar podia custar vários minutos.
// Pior: a lista de conversas pede ~20 avatares de uma vez, sem deduplicação,
// e cada um ocupava uma IQ pendurada no mesmo websocket que precisa decifrar
// as mensagens.
//
// Agora: timeout curto e próprio (4s), no máximo 2 candidatos, e deduplicação
// de requisições concorrentes pelo mesmo userId.
const PHOTO_QUERY_TIMEOUT_MS = Number(process.env.PHOTO_QUERY_TIMEOUT_MS || 4000);
const PHOTO_MAX_CANDIDATOS   = Number(process.env.PHOTO_MAX_CANDIDATOS || 2);
const _photoInflight = new Map();   // userId -> Promise em andamento

async function getProfilePhotoUrl(userId) {
  // Sem socket OU com socket desconectado: não adianta enfileirar uma IQ que
  // ninguém vai responder — antes só checava `conn.sock`, que continua
  // definido durante toda a reconexão.
  if (!conn.sock || !conn.isWhatsAppConnected) return null;

  const chave = String(userId || "");
  if (!chave) return null;

  const emAndamento = _photoInflight.get(chave);
  if (emAndamento) return emAndamento;

  const promessa = (async () => {
    const candidates = getProfilePhotoCandidates(userId).slice(0, PHOTO_MAX_CANDIDATOS);

    for (const jid of candidates) {
      try {
        const url = await withTimeout(
          conn.sock.profilePictureUrl(jid, "image"),
          PHOTO_QUERY_TIMEOUT_MS,
          `foto de perfil de ${jid}`
        );
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
  })().finally(() => _photoInflight.delete(chave));

  _photoInflight.set(chave, promessa);
  return promessa;
}

// Reconstrói o objeto mínimo que o Baileys precisa para exibir a prévia de
// "respondendo a" (quoted) no WhatsApp do cliente — não precisamos do objeto
// original completo da mensagem (Baileys aceita esse formato reduzido, desde
// que key.id/key.remoteJid/key.fromMe estejam corretos e message tenha algum
// texto). Ver BUG CORRIGIDO / escopo em message.controller.js
// (_buscarContextoCitacao): por ora só citamos mensagens do CLIENTE
// (fromMe sempre false).
function _buildQuotedMessage(resolvedJid, quotedMessageId, quotedText) {
  if (!quotedMessageId) return undefined;
  return {
    key: { remoteJid: resolvedJid, id: quotedMessageId, fromMe: false },
    message: { conversation: quotedText || "" },
  };
}

async function sendMessage(userId, text, { quotedMessageId, quotedText } = {}) {
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

    const quoted = _buildQuotedMessage(resolvedJid, quotedMessageId, quotedText);
    const sent = await conn.sock.sendMessage(resolvedJid, { text }, quoted ? { quoted } : undefined);
    logger.info(`[sendMessage] ✓ Enviado para ${resolvedJid}${quoted ? " (em resposta a " + quotedMessageId + ")" : ""}`);

    // Registra o id no dedup ASSIM QUE enviamos — quando o Baileys ecoar essa
    // mesma mensagem de volta via messages.upsert (fromMe:true, comum com
    // múltiplos dispositivos), onMessagesUpsert já vai reconhecer que FOI
    // A GENTE quem mandou (painel/bot) e não duplicar no histórico. Ver
    // isOutgoingEcho() em message-utils.js e o comentário em
    // onMessagesUpsert — sem isso, o mesmo id chegaria "não reconhecido" e
    // seria tratado (errado) como mensagem enviada pelo celular.
    if (sent?.key?.id) { try { await marcarMensagemProcessada(sent.key.id); } catch (_) {} }

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

// mediaType: "image" | "video" | "document" | "pdf" (legado, ver nota abaixo) | "audio"
// options: { quotedMessageId, quotedText, mimetype, fileName }
//   - mimetype/fileName: só relevantes pra "document"/"video" com nome/tipo
//     próprio (vem do upload do painel — ver mediaStorage/message.controller);
//     sem eles, cai no fallback genérico (mesmo comportamento de antes).
// BUG CORRIGIDO (2026-07-23, feature nova "enviar arquivo igual WhatsApp"):
// só existiam os tipos "pdf"/"audio"/"image" (uso exclusivo de campanhas via
// broadcast.service.js, que só oferece essas 3 opções pro usuário) — não
// havia "video" nem um "document" genérico (qualquer extensão, como o
// WhatsApp de verdade aceita ao anexar um documento). "pdf" continua
// funcionando exatamente igual (broadcast.service.js não muda), só não é
// mais o único jeito de mandar documento.
async function sendMedia(userId, filePath, caption = "", mediaType = "image", options = {}) {
  if (!conn.sock) throw new Error("WhatsApp não inicializado.");
  if (!conn.isWhatsAppConnected) throw new Error("WhatsApp não autenticado. Escaneie o QR Code no painel.");

  const { quotedMessageId, quotedText, mimetype, fileName: fileNameOverride } = options;

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
    const fileName = fileNameOverride || path.basename(filePath);

    if (mediaType === "pdf") {
      msgContent = {
        document: fileData,
        mimetype: "application/pdf",
        fileName,
        caption: caption || undefined,
      };
    } else if (mediaType === "document") {
      msgContent = {
        document: fileData,
        mimetype: mimetype || "application/octet-stream",
        fileName,
        caption: caption || undefined,
      };
    } else if (mediaType === "video") {
      msgContent = {
        video: fileData,
        mimetype: mimetype || "video/mp4",
        caption: caption || undefined,
      };
    } else if (mediaType === "audio") {
      msgContent = {
        audio: fileData,
        mimetype: mimetype || "audio/mpeg",
        ptt: false,
      };
    } else {
      msgContent = { image: fileData, caption: caption || undefined };
    }

    const quoted = _buildQuotedMessage(resolvedJid, quotedMessageId, quotedText);
    const sent = await conn.sock.sendMessage(resolvedJid, msgContent, quoted ? { quoted } : undefined);
    logger.info(`[WhatsApp] ✓ Mídia (${mediaType}) enviada para ${resolvedJid}`);

    // Ver mesmo comentário em sendMessage() — registra o id no dedup pra não
    // duplicar quando o eco fromMe chegar de volta.
    if (sent?.key?.id) { try { await marcarMensagemProcessada(sent.key.id); } catch (_) {} }

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

// Intervalo único do watchdog, iniciado uma vez no carregamento do módulo
// (não a cada connectWhatsApp/reconexão — watchdogTick já lê conn.sock/
// conn.isWhatsAppConnected por closure, então não precisa ser recriado).
setInterval(() => {
  watchdogTick().catch(err => logger.error(`[Watchdog] Erro inesperado: ${err.message}`));
}, WATCHDOG_INTERVAL_MS);


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
