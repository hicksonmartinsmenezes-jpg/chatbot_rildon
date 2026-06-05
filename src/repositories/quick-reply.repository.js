const pool = require("../database/postgres");

function mapReply(row) {
  return {
    id: row.id,
    shortcut: row.shortcut,
    message: row.message,
    createdAt: row.created_at
  };
}

async function findAll() {
  const result = await pool.query(`
    SELECT *
    FROM quick_replies
    ORDER BY shortcut ASC
  `);

  return result.rows.map(mapReply);
}

async function replaceAll(replies = []) {
  await pool.query("DELETE FROM quick_replies");

  const saved = [];

  for (const reply of replies) {
    const result = await pool.query(
      `
      INSERT INTO quick_replies (
        shortcut,
        message,
        created_at
      )
      VALUES ($1,$2,$3)
      RETURNING *
      `,
      [
        reply.shortcut,
        reply.message,
        reply.createdAt || new Date()
      ]
    );

    saved.push(mapReply(result.rows[0]));
  }

  return saved;
}

async function findByShortcut(shortcut) {
  const result = await pool.query(
    `
    SELECT *
    FROM quick_replies
    WHERE LOWER(shortcut) = LOWER($1)
    LIMIT 1
    `,
    [shortcut]
  );

  return result.rows[0] ? mapReply(result.rows[0]) : null;
}

module.exports = {
  findAll,
  replaceAll,
  findByShortcut
};