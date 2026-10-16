const { sendMessage, sendMedia, sendTypingPresence } = require("../config/whatsapp");
const { saveHistory } = require("../services/history.service");
const historyRepository = require("../repositories/history.repository");
const { emitEvent }   = require("../services/socket.service");
const humanMode       = require("../services/humanMode.service");
const logger          = require("../utils/logger");
const fs              = require("fs");
const ticketRepository = require("../repositories/ticket.repository");
const { createTicket, updateTicketStatus, assignTicket } = require("../services/ticket.service");
const { canAccessTicket, isPrivileged, canUseFullConversationPanel } = require("../utils/access-control");
const { getProfilePhotoCandidates } = require("../whatsapp/lid-map");
const { buscarNomeContatoReal } = require("../whatsapp/contacts");

// PEDIDO DO USUÁRIO (2026-09-23, "observe nem foi fechado hoje e ele ja esta
// definido como resolvido"): reportado com uma conversa real onde o cliente
// perguntava sobre produtos e o atendente já respondia manualmente ("tô
// terminando um atendimento, ok"), mas o ticket mais recente desse cliente
// continuava "resolvido". Causa raiz: sendManualMessage (abaixo) só chamava
// humanMode.ativar() — nunca criava/reabria/atribuía ticket nenhum. Isso é
// intencional pra reabertura AUTOMÁTICA (reopenTicketIfClosed em
// ticket.service.js só reabre dentro de uma janela de tempo — fora dela,
// espera o cliente "pedir algo de verdade" pra um ticket novo nascer pelo
// fluxo do bot, ver comentário lá), mas quando um ATENDENTE intervém
// manualmente antes desse fluxo criar o ticket (como aconteceu aqui), a
// conversa passa a ser 100% humana sem NENHUM ticket refletindo isso — o
// painel mostra "resolvido" para um atendimento que está, na prática,
// acontecendo agora. Esta função garante que existe um ticket ABERTO e
// atribuído a quem está respondendo, reaproveitando a mesma lógica de
// reabertura/atribuição já usada pelos botões "Iniciar Atendimento"/
// "Reabrir" (ticket.controller.js) — sem duplicar a lógica de satisfação/
// saudação, que updateTicketStatus já cobre. Best-effort: nunca deve
// impedir o envio da mensagem em si (chamada depois que ela já foi enviada).
async function _ensureTicketForManualReply(userId, user, contactName) {
  try {
    const candidatos = getProfilePhotoCandidates(userId);
    const tickets = await ticketRepository.findByUserIds(candidatos.length ? candidatos : [userId]);
    const ativo = tickets.find(t => t.status === "aberto" || t.status === "em_andamento");

    if (ativo) {
      // Já existe atendimento ativo — só assume se ainda não tiver atendente
      // (não "rouba" cliente de outro atendente, mesma regra do resto do
      // painel — ver canUserAccessConversation/assign no repository).
      if (!ativo.assignedTo) {
        const atribuido = await assignTicket(ativo.id, user);
        if (atribuido && !atribuido.notFound && !atribuido.alreadyAssigned) {
          emitEvent("ticket_atualizado", { ticket: atribuido });
        }
      }
      return;
    }

    const latest = tickets[0]; // já ordenado DESC (ver ticketRepository.findByUserIds)
    let ticket;
    if (latest && (latest.status === "resolvido" || latest.status === "cancelado")) {
      ticket = await updateTicketStatus(latest.id, "aberto", { ticketAtual: latest });
    } else {
      ticket = await createTicket({
        userId,
        type: "atendente_humano",
        sector: "atendimento",
        customerName: contactName || "Não informado",
        description: "[Atendimento iniciado manualmente pelo painel]"
      });
    }
    if (!ticket) return;

    const atribuido = await assignTicket(ticket.id, user);
    const ticketFinal = (atribuido && !atribuido.notFound && !atribuido.alreadyAssigned) ? atribuido : ticket;
    emitEvent("ticket_atualizado", { ticket: ticketFinal });
  } catch (err) {
    logger.warn(`[_ensureTicketForManualReply] ${err.message}`);
  }
}

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

// Traduz o erro do envio no WhatsApp para um status HTTP + mensagem úteis.
// Antes tudo virava "500 Erro ao enviar mensagem." sem detalhe — o alerta do
// painel X2 mostrava só "HTTP 500" mesmo quando a causa era o WhatsApp
// desconectado (QR) ou um número fora do WhatsApp.
function traduzirErroEnvio(error, fallback) {
  const msg = String(error?.message || "");
  if (/não autenticado|não inicializado/i.test(msg)) {
    return { status: 503, error: "WhatsApp desconectado — escaneie o QR Code no painel e tente de novo." };
  }
  if (/não está registrado no WhatsApp/i.test(msg)) {
    return { status: 422, error: msg };
  }
  return { status: 500, error: fallback };
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

    // Ver comentário em _ensureTicketForManualReply acima — garante que o
    // ticket reflete que este cliente está em atendimento humano agora.
    // Best-effort (nunca lança) — roda antes de salvar/emitir o histórico
    // pra qualquer socket "ticket_atualizado" já chegar coerente com o
    // "nova_mensagem" que vem logo em seguida.
    await _ensureTicketForManualReply(userId, req.user, contactName);

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
    const t = traduzirErroEnvio(error, "Erro ao enviar mensagem.");
    res.status(t.status).json({ error: t.error });
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
    const t = traduzirErroEnvio(error, "Erro ao enviar arquivo.");
    res.status(t.status).json({ error: t.error });
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
  releaseHumanMode,
  ensureTicketForManualReply: _ensureTicketForManualReply
};
