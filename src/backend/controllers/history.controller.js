const { listHistory } = require("../services/history.service");
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

async function getConversationsHandler(req, res) {
  try {
    const pool = require("../database/postgres");
    const tz   = process.env.TZ_NEGOCIO || "America/Maceio";

    // Retorna o registro mais recente por usuário — sem limite de usuários únicos
    const result = await pool.query(`
      SELECT DISTINCT ON (user_id)
        id, user_id, contact_name, message, response, sector, status, message_id, created_at
      FROM history
      ORDER BY user_id, created_at DESC
    `);

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
  getConversationsHandler,
};