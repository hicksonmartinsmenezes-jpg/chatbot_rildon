const pool = require("../database/postgres");

function mapLog(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    action: row.action,
    description: row.description,
    extra: row.extra || {},
    createdAt: row.created_at
  };
}

async function findAll(limit = 500) {
  const result = await pool.query(
    `
    SELECT *
    FROM activity_logs
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [limit]
  );

  return result.rows.map(mapLog);
}

async function create(data) {
  const result = await pool.query(
    `
    INSERT INTO activity_logs (
      user_id,
      user_name,
      action,
      description,
      extra,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING *
    `,
    [
      data.userId || "system",
      data.userName || "Sistema",
      data.action,
      data.description,
      JSON.stringify(data.extra || {}),
      data.createdAt || new Date()
    ]
  );

  return mapLog(result.rows[0]);
}

module.exports = {
  findAll,
  create
};