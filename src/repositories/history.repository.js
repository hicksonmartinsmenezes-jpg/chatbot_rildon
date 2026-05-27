const crypto = require("crypto");
const pool = require("../database/postgres");

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
  const id = data.id || crypto.randomUUID();

  const result = await pool.query(
    `
    INSERT INTO history (
      id,
      user_id,
      contact_name,
      message,
      response,
      sector,
      status,
      message_id,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
    `,
    [
      id,
      data.userId,
      data.contactName || "",
      data.message || null,
      data.response || null,
      data.sector || "geral",
      data.status || "",
      data.messageId || null,
      data.createdAt || new Date()
    ]
  );

  return mapHistory(result.rows[0]);
}

async function findAll({
  userId,
  limit = 50,
  offset = 0
} = {}) {
  const values = [];
  const where = [];

  if (userId) {
    values.push(userId);
    where.push(`user_id = $${values.length}`);
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
  const result = await pool.query(
    `
    UPDATE history
    SET status = $1
    WHERE message_id = $2
    RETURNING *
    `,
    [status, messageId]
  );

  return result.rows[0] ? mapHistory(result.rows[0]) : null;
}

module.exports = {
  create,
  findAll,
  updateMessageStatus
};