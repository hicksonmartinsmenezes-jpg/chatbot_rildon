const fs = require("fs");
const { listHistory, listHistoryGrouped, getHistoryById } = require("../services/history.service");
const { resolverCaminhoMidia } = require("../services/mediaStorage.service");
const { canonicalizeUserId } = require("../whatsapp/lid-map");
const logger = require("../utils/logger");

async function getHistoryHandler(req, res) {
  try {
    const { userId, q, from, to } = req.query;

    const page = Math.max(
      parseInt(req.query.page || "1", 10),
      1
    );

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200
    );

    const offset = (page - 1) * limit;

    const result = await listHistory({
      userId,
      limit,
      offset,
      q:    q    || undefined,
      from: from || undefined,
      to:   to   || undefined,
    });

    res.json({
      page,
      limit,
      count: result.length,
      data: result
    });

  } catch (err) {
    logger.error(
      "❌ Erro ao buscar histórico:",
      err.message
    );

    res.status(500).json({
      page: 1,
      limit: 50,
      count: 0,
      data: []
    });
  }
}

// Visão do painel de Histórico: uma linha por cliente (mensagem mais
// recente + total de interações), não um recorte plano das últimas N
// mensagens da loja inteira — ver comentário em history.repository.js
// (findGroupedByUser) sobre o bug que isso corrige.
async function getHistoryGroupedHandler(req, res) {
  try {
    const { q, from, to } = req.query;

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "500", 10), 1),
      2000
    );
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);

    const result = await listHistoryGrouped({
      q:    q    || undefined,
      from: from || undefined,
      to:   to   || undefined,
      limit,
      offset,
    });

    res.json({ count: result.length, data: result });
  } catch (err) {
    logger.error("❌ Erro ao buscar histórico agrupado:", err.message);
    res.status(500).json({ count: 0, data: [] });
  }
}

// Teto de segurança para o painel de Conversas — não é paginação de verdade
// (a busca do painel ainda é client-side, sobre o array inteiro recebido
// aqui), só evita que a resposta cresça sem limite conforme a base de
// clientes aumenta. Se um dia isso for atingido na prática, a busca de
// conversas precisa virar um parâmetro de servidor (como já é em
// listContacts), não só aumentar este número.
const MAX_CONVERSATIONS = 2000;

async function getConversationsHandler(req, res) {
  try {
    const pool = require("../database/postgres");

    // Retorna o registro mais recente por usuário, limitado às conversas
    // mais recentemente ativas — sem isso a query varre a tabela history
    // inteira a cada 30s (polling do painel de Conversas).
    const result = await pool.query(`
      SELECT id, user_id, contact_name, message, response, sector, status, message_id,
             media_path, media_mimetype, media_filename, created_at
      FROM (
        SELECT DISTINCT ON (user_id)
          id, user_id, contact_name, message, response, sector, status, message_id,
          media_path, media_mimetype, media_filename, created_at
        FROM history
        ORDER BY user_id, created_at DESC
      ) mais_recente_por_usuario
      ORDER BY created_at DESC
      LIMIT $1
    `, [MAX_CONVERSATIONS]);

    // BUG CORRIGIDO (#96): o mesmo cliente real pode ter linhas em `history`
    // com o user_id salvo em DOIS formatos — "...@lid" e já resolvido para
    // "...@s.whatsapp.net" (ver LID_FALLBACK em config/whatsapp.js). Como a
    // subquery acima faz DISTINCT ON (user_id) LITERAL, esse cliente vira
    // DUAS linhas na lista de conversas do painel — e pior, o frontend cruza
    // essa lista com /api/tickets por userId (ticketsByUser[userId]); se o
    // ticket estiver salvo sob o OUTRO formato, a conversa aparece como "sem
    // ticket" mesmo já tendo um. canonicalizeUserId() resolve @lid → jid
    // conhecido (mesma lógica já usada em contacts.js/humanMode/broadcast),
    // e o Map abaixo colapsa as duas linhas em uma só — como a query externa
    // já ordena por created_at DESC, a primeira ocorrência de cada id
    // canônico é sempre a mais recente.
    const porUsuarioCanonico = new Map();
    for (const r of result.rows) {
      const userId = canonicalizeUserId(r.user_id);
      if (porUsuarioCanonico.has(userId)) continue;
      porUsuarioCanonico.set(userId, {
        id:          r.id,
        userId,
        contactName: r.contact_name,
        message:     r.message,
        response:    r.response,
        sector:      r.sector,
        status:      r.status,
        messageId:   r.message_id,
        mediaPath:     r.media_path,
        mediaMimetype: r.media_mimetype,
        mediaFilename: r.media_filename,
        createdAt:   r.created_at,
      });
    }

    res.json([...porUsuarioCanonico.values()]);
  } catch (err) {
    logger.error("❌ Erro ao buscar conversas:", err.message);
    res.status(500).json([]);
  }
}

// Serve o arquivo de mídia (foto/áudio/vídeo/sticker/documento) recebido do
// cliente e salvo em disco por config/whatsapp.js (ver migration 017 e
// mediaStorage.service.js). Protegida por authSession (mesmo nível de
// acesso do resto de historyRoutes) — diferente do handler público de
// /uploads/* em app.js (fotos de perfil/campanha, baixa sensibilidade),
// conversa de cliente é dado privado e não deve ficar acessível sem login
// só por adivinhar/vazar a URL.
async function serveMediaHandler(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: "id inválido." });
    }

    const item = await getHistoryById(id);
    if (!item || !item.mediaPath) {
      return res.status(404).json({ error: "Mídia não encontrada." });
    }

    const filePath = resolverCaminhoMidia(item.mediaPath);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Arquivo não encontrado." });
    }

    res.setHeader("Content-Type", item.mediaMimetype || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (item.mediaFilename) {
      // Documento com nome original (ex: PDF que o cliente mandou) — sugere
      // esse nome no download, mas ainda exibe inline quando o navegador
      // suportar (sem "attachment", pra não forçar download de foto/áudio).
      res.setHeader("Content-Disposition", `inline; filename="${item.mediaFilename.replace(/["\r\n]/g, "")}"`);
    }
    res.sendFile(filePath);
  } catch (err) {
    logger.error("❌ Erro ao servir mídia do histórico:", err.message);
    res.status(500).json({ error: "Erro ao carregar mídia." });
  }
}

module.exports = {
  getHistoryHandler,
  getHistoryGroupedHandler,
  getConversationsHandler,
  serveMediaHandler,
};
