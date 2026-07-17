const { listHistory, listHistoryGrouped } = require("../services/history.service");
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
      SELECT id, user_id, contact_name, message, response, sector, status, message_id, created_at
      FROM (
        SELECT DISTINCT ON (user_id)
          id, user_id, contact_name, message, response, sector, status, message_id, created_at
        FROM history
        ORDER BY user_id, created_at DESC
      ) mais_recente_por_usuario
      ORDER BY created_at DESC
      LIMIT $1
    `, [MAX_CONVERSATIONS]);

    const rows = result.rows.map(r => ({
      id:          r.id,
      userId:      r.user_id,
      contactName: r.contact_name,
      message:     r.message,
      response:    r.response,
      sector:      r.sector,
      status:      r.status,
      messageId:   r.message_id,
      createdAt:   r.created_at,
    }));

    res.json(rows);
  } catch (err) {
    logger.error("❌ Erro ao buscar conversas:", err.message);
    res.status(500).json([]);
  }
}

module.exports = {
  getHistoryHandler,
  getHistoryGroupedHandler,
  getConversationsHandler,
};
