const { sendMessage, sendMedia, sendTypingPresence } = require("../config/whatsapp");
const { saveHistory } = require("../services/history.service");
const historyRepository = require("../repositories/history.repository");
const { emitEvent }   = require("../services/socket.service");
const humanMode       = require("../services/humanMode.service");
const logger          = require("../utils/logger");
const fs              = require("fs");
const ticketRepository = require("../repositories/ticket.repository");
const { canAccessTicket, isPrivileged, canUseFullConversationPanel } = require("../utils/access-control");
const { getProfilePhotoCandidates } = require("../whatsapp/lid-map");
const { buscarNomeContatoReal } = require("../whatsapp/contacts");

// "Responder mensagem específica" (reply/quote, igual WhatsApp) — busca o
// texto da mensagem citada pra (a) montar o objeto "quoted" que o Baileys
// manda pro WhatsApp de verdade do cliente, e (b) salvar quoted_text no
// histórico, pro painel poder mostrar a prévia da citação sem precisar de
// outro SELECT.
//
// ESCOPO: só suporta citar mensagens do CLIENTE. Uma linha de `history`
// mistura duas coisas sob um único `message_id`: quando a linha nasce de uma
// mensagem recebida (message.service.js), o id é da mensagem do CLIENTE;
// quando nasce de um envio manual do atendente (sendManualMessage/
// sendMediaMessage), o id é da mensagem que o PRÓPRIO atendente mandou. Não
// dá pra saber, só pelo message_id, qual dos dois lados ele representa sem
// mais contexto — e citar uma resposta do bot/atendente exigiria guardar o
// WhatsApp-id de CADA resposta automática separadamente (não é feito hoje).
// Por isso, aqui: só aceita citar quando a linha tem `message` (texto do
// cliente) preenchido — a mesma regra que o frontend usa pra decidir se
// mostra o botão de responder numa bolha (ver conversations-render.js).
async function _buscarContextoCitacao(userId, quotedMessageId) {
  if (!quotedMessageId) return null;

  // findAll já expande userId pras variantes lid/jid equivalentes (ver
  // getProfilePhotoCandidates dentro de history.repository.js).
  const linhas = await historyRepository.findAll({ userId, limit: 200 });
  const linha = linhas.find(l => l.messageId === quotedMessageId && l.message);
  if (!linha) return null;

  return { quotedMessageId, quotedText: linha.message.slice(0, 300) };
}

// Autorização de conversa: privilegiados (admin/supervisor/api) sempre podem.
// Atendente só acessa se houver ticket ATIVO atribuído a ele — ou não atribuído
// no mesmo setor (allowUnassigned). Centraliza a regra antes repetida 3×.
async function canUserAccessConversation(user, userId) {
  if (isPrivileged(user) || canUseFullConversationPanel(user)) return true;

  // BUG CORRIGIDO: mesma causa raiz do guard de reabrir ticket — o WhatsApp
  // entrega mensagens do mesmo cliente ora como "...@lid" ora já resolvidas
  // para "...@s.whatsapp.net" (ver LID_FALLBACK em src/config/whatsapp.js).
  // Buscar só por userId exato podia não achar o ticket ATIVO do cliente
  // quando ele estava salvo no OUTRO formato, gerando um 403 falso pro
  // atendente que legitimamente tem acesso à conversa.
  const candidatos = getProfilePhotoCandidates(userId);
  const tickets = await ticketRepository.findByUserIds(candidatos.length ? candidatos : [userId]);
  const ativos  = tickets.filter(t => t.status === "aberto" || t.status === "em_andamento");
  return ativos.some(t => canAccessTicket(user, t, { allowUnassigned: true }));
}

async function sendManualMessage(req, res) {
  try {
    const { userId, message, quotedMessageId } = req.body || {};

    if (!userId || !message) {
      return res.status(400).json({
        error: "userId e message são obrigatórios."
      });
    }

    // CORRIGIDO: garante que message é string
    if (typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({ error: "message deve ser uma string não vazia." });
    }

    if (message.length > 4096) {
      return res.status(400).json({ error: "Mensagem muito longa (máx. 4096 caracteres)." });
    }

    // Segurança: atendente só pode enviar mensagem para conversa permitida.
    if (!(await canUserAccessConversation(req.user, userId))) {
      return res.status(403).json({ error: "Você não tem permissão para enviar mensagem para esta conversa." });
    }

    // "Responder mensagem específica" (reply/quote) — ver _buscarContextoCitacao
    // acima para o escopo (só cita mensagens do cliente). quotedMessageId
    // inválido/não encontrado não bloqueia o envio — só manda sem citação.
    const citacao = await _buscarContextoCitacao(userId, quotedMessageId).catch(() => null);

    const sent = await sendMessage(userId, message.trim(), citacao || {});

    // Atendente enviou mensagem → assume a conversa e pausa o bot para este cliente
    humanMode.ativar(userId, { agentName: req.user?.nome || req.user?.usuario || "" });

    // Busca o nome REAL do contato (WhatsApp) para não deixar em branco.
    // BUG CORRIGIDO: antes buscava "o contact_name mais recente no
    // histórico" — se ALGUMA mensagem anterior já tivesse sido salva com
    // um nome errado (ex: ticket.customerName desatualizado), esse erro
    // se perpetuava em cascata pra toda mensagem manual seguinte. Agora
    // usa a mesma fonte única (contacts.nome) de main.flow.js e
    // ticket.controller.js — ver buscarNomeContatoReal em
    // src/whatsapp/contacts.js.
    let contactName = "";
    try {
      contactName = (await buscarNomeContatoReal(userId)) || "";
    } catch (_) {}

    // Salva histórico separado do envio — falha aqui não afeta a resposta ao frontend
    let historyItem = null;
    try {
      historyItem = await saveHistory({
        userId,
        contactName,
        message: null,
        response: message.trim(),
        sector: "manual",
        messageId: sent?.id || null,
        status: "sent",
        quotedMessageId: citacao?.quotedMessageId || null,
        quotedText: citacao?.quotedText || null
      });

      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message: null,
        response: message.trim(),
        sector: "manual",
        messageId: sent?.id || null,
        status: "sent",
        quotedMessageId: citacao?.quotedMessageId || null,
        quotedText: citacao?.quotedText || null,
        createdAt: new Date()
      });
    } catch (histErr) {
      logger.warn(`[sendManualMessage] Histórico não salvo: ${histErr.message}`);
    }

    res.json({
      success: true,
      messageId: sent?.id || null,
      remoteJid: sent?.remoteJid || null,
      fromMe: sent?.fromMe ?? true,
      history: historyItem
    });

  } catch (error) {
    logger.error(`[sendManualMessage] ${error.message}`);
    res.status(500).json({ error: "Erro ao enviar mensagem." });
  }
}

// Feature nova (2026-07-23, pedido do usuário): "enviar arquivo exatamente
// igual WhatsApp" — foto/vídeo/documento pelo painel. req.file já foi
// salvo em disco por multer (ver message.routes.js, destino = MEDIA_DIR de
// mediaStorage.service.js — mesma pasta usada pra mídia RECEBIDA do
// cliente, servida pela rota já existente GET /api/history/media/:id, sem
// precisar de rota nova pra servir de volta).
async function sendMediaMessage(req, res) {
  const cleanupOnError = () => {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
  };

  try {
    const { userId, caption, quotedMessageId } = req.body || {};
    const { mediaType } = req; // setado por detectMessageMediaType em message.routes.js

    if (!userId) {
      cleanupOnError();
      return res.status(400).json({ error: "userId é obrigatório." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Nenhum arquivo enviado." });
    }
    if (!mediaType) {
      cleanupOnError();
      return res.status(400).json({ error: "Tipo de arquivo não suportado." });
    }
    if (caption && (typeof caption !== "string" || caption.length > 1024)) {
      cleanupOnError();
      return res.status(400).json({ error: "Legenda inválida (máx. 1024 caracteres)." });
    }

    if (!(await canUserAccessConversation(req.user, userId))) {
      cleanupOnError();
      return res.status(403).json({ error: "Você não tem permissão para enviar arquivo para esta conversa." });
    }

    const citacao = await _buscarContextoCitacao(userId, quotedMessageId).catch(() => null);

    const legenda = (caption || "").trim();
    const sent = await sendMedia(userId, req.file.path, legenda, mediaType, {
      ...(citacao || {}),
      mimetype: req.file.mimetype,
      fileName: req.file.originalname,
    });

    humanMode.ativar(userId, { agentName: req.user?.nome || req.user?.usuario || "" });

    let contactName = "";
    try {
      contactName = (await buscarNomeContatoReal(userId)) || "";
    } catch (_) {}

    // media_path guarda só o NOME do arquivo (nunca o caminho completo do
    // disco) — mesma convenção de mediaStorage.service.js/migration 017.
    const mediaFilename = require("path").basename(req.file.path);

    // BUG EVITADO (achado ao implementar esta feature): o painel decide de
    // qual lado renderizar a bolha (cliente à esquerda vs atendente à
    // direita) olhando se a linha tem `message` (cliente) ou `response`
    // (atendente/bot) preenchido — ver 07-conversations.js. Mídia RECEBIDA
    // do cliente sempre grava um rótulo em `message` (ex: "[imagem
    // recebido]"), então isso nunca fica vazio. Mídia ENVIADA pelo atendente
    // sem legenda ficaria com `message` E `response` nulos, e só `mediaPath`
    // setado — o painel cairia no mesmo `if (item.message || item.mediaPath)`
    // usado pra mídia recebida e mostraria o arquivo enviado pelo ATENDENTE
    // do lado do CLIENTE. Por isso `response` sempre recebe um rótulo aqui
    // quando não há legenda (mesma convenção do lado receptor).
    const respostaHistorico = legenda || "[arquivo enviado]";

    let historyItem = null;
    try {
      historyItem = await saveHistory({
        userId,
        contactName,
        message: null,
        response: respostaHistorico,
        sector: "manual",
        messageId: sent?.id || null,
        status: "sent",
        mediaPath: mediaFilename,
        mediaMimetype: req.file.mimetype,
        mediaFilename: req.file.originalname,
        quotedMessageId: citacao?.quotedMessageId || null,
        quotedText: citacao?.quotedText || null
      });

      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message: null,
        response: respostaHistorico,
        sector: "manual",
        messageId: sent?.id || null,
        status: "sent",
        mediaPath: mediaFilename,
        mediaMimetype: req.file.mimetype,
        mediaFilename: req.file.originalname,
        quotedMessageId: citacao?.quotedMessageId || null,
        quotedText: citacao?.quotedText || null,
        createdAt: new Date()
      });
    } catch (histErr) {
      logger.warn(`[sendMediaMessage] Histórico não salvo: ${histErr.message}`);
    }

    res.json({
      success: true,
      messageId: sent?.id || null,
      remoteJid: sent?.remoteJid || null,
      fromMe: sent?.fromMe ?? true,
      history: historyItem
    });

  } catch (error) {
    cleanupOnError();
    logger.error(`[sendMediaMessage] ${error.message}`);
    res.status(500).json({ error: "Erro ao enviar arquivo." });
  }
}

async function sendTyping(req, res) {
  try {
    const { userId } = req.body || {};

    if (!userId) {
      return res.status(400).json({ error: "userId obrigatório." });
    }

    if (!(await canUserAccessConversation(req.user, userId))) {
      return res.status(403).json({ error: "Você não tem permissão para sinalizar digitação nesta conversa." });
    }

    emitEvent("typing", { userId, from: "agent" });

    await sendTypingPresence(userId);

    return res.json({ success: true });

  } catch (error) {
    // CORRIGIDO: console.error → logger.error
    logger.error(`[sendTyping] ${error.message}`);
    return res.status(500).json({ error: "Erro ao enviar presença." });
  }
}

// Lista os clientes atualmente em atendimento humano (bot pausado)
function listHumanMode(req, res) {
  res.json({ users: humanMode.listar() });
}

// "Devolver ao bot" — reativa o bot para um cliente
async function releaseHumanMode(req, res) {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId obrigatório." });

  if (!(await canUserAccessConversation(req.user, userId))) {
    return res.status(403).json({ error: "Você não tem permissão para devolver esta conversa ao bot." });
  }

  humanMode.desativar(userId, "painel");
  return res.json({ ok: true });
}

module.exports = {
  sendManualMessage,
  sendMediaMessage,
  sendTyping,
  listHumanMode,
  releaseHumanMode
};
