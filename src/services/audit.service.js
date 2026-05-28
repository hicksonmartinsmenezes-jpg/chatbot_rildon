const pool = require("../database/postgres");

async function getAuditLogs() {
  const result = await pool.query(`
    SELECT
      id,
      user_id,
      user_name,
      user_role,
      action,
      target,
      details,
      created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT 1000
  `);

  return result.rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userRole: row.user_role,
    action: row.action,
    target: row.target,
    details: row.details || {},
    createdAt: row.created_at
  }));
}

async function auditLog({ user, action, target, details }) {
  const result = await pool.query(
    `
    INSERT INTO audit_logs (
      user_id,
      user_name,
      user_role,
      action,
      target,
      details,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING *
    `,
    [
      user?.id || "sistema",
      user?.nome || user?.usuario || "Sistema",
      user?.perfil || "system",
      action,
      target || null,
      JSON.stringify(details || {})
    ]
  );

  const row = result.rows[0];

  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userRole: row.user_role,
    action: row.action,
    target: row.target,
    details: row.details || {},
    createdAt: row.created_at
  };
}

module.exports = {
  getAuditLogs,
  auditLog
};