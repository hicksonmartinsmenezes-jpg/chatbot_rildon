const pool   = require("../database/postgres");
const logger = require("../utils/logger");

function mapHistory(row) {
  return {
    id: row.id,
    userId: row.user_id,
    contactName: row.contact_name,
    message: row.message,
    response: row.response,
    sector: row.sector,
    status: row.status,
    messageId: row.message_id,
    createdAt: row.created_at
  };
}

async function create(data) {
  const result = await pool.query(
    `
    INSERT INTO history (
      user_id,
      contact_name,
      message,
      response,
      sector,
      status,
      message_id,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [
      data.userId,
      data.contactName || "",
      data.message || null,
      data.response || null,
      data.sector || "geral",
      data.status || null,
      data.messageId || null,
      data.createdAt || new Date()
    ]
  );

  return mapHistory(result.rows[0]);
}

async function findAll({ userId, limit = 50, offset = 0, q, from, to } = {}) {
  const values = [];
  const where = [];

  if (userId) {
    values.push(userId);
    where.push(`user_id = $${values.length}`);
  }

  if (q) {
    const pattern = `%${q}%`;
    values.push(pattern); const i1 = values.length;
    values.push(pattern); const i2 = values.length;
    values.push(pattern); const i3 = values.length;
    values.push(pattern); const i4 = values.length;
    where.push(`(user_id ILIKE $${i1} OR contact_name ILIKE $${i2} OR message ILIKE $${i3} OR response ILIKE $${i4})`);
  }

  const tz = process.env.TZ_NEGOCIO || "America/Maceio";
  if (from) {
    values.push(from);
    where.push(`(created_at AT TIME ZONE '${tz}')::date >= $${values.length}::date`);
  }

  if (to) {
    values.push(to);
    where.push(`(created_at AT TIME ZONE '${tz}')::date <= $${values.length}::date`);
  }

  values.push(Number(limit) || 50);
  const limitIndex = values.length;

  values.push(Number(offset) || 0);
  const offsetIndex = values.length;

  const result = await pool.query(
    `
    SELECT *
    FROM history
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
    `,
    values
  );

  return result.rows.map(mapHistory);
}

async function updateMessageStatus(messageId, status) {
  if (!messageId) {
    logger.warn("[History] updateMessageStatus: messageId vazio, ignorado.");
    return null;
  }

  const result = await pool.query(
    `UPDATE history SET status = $1 WHERE message_id = $2 RETURNING *`,
    [status, messageId]
  );

  return result.rows[0] ? mapHistory(result.rows[0]) : null;
}

module.exports = {
  create,
  findAll,
  updateMessageStatus
};