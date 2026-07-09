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

// Limite de parâmetros por lote (3 colunas por linha) — bem abaixo do teto
// de ~65535 parâmetros do PostgreSQL por query.
const INSERT_CHUNK = 500;

async function replaceAll(replies = []) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM quick_replies");

    let saved = [];

    // Insere em lote (em vez de um INSERT por resposta rápida) e tudo numa
    // transação — antes o DELETE e os INSERTs individuais não estavam numa
    // transação: se o processo caísse no meio do loop, as respostas rápidas
    // ficavam apagadas sem serem recriadas.
    for (let i = 0; i < replies.length; i += INSERT_CHUNK) {
      const slice = replies.slice(i, i + INSERT_CHUNK);
      const values = [];
      const params = [];

      slice.forEach((reply, j) => {
        const b = j * 3;
        values.push(`($${b + 1},$${b + 2},$${b + 3})`);
        params.push(reply.shortcut, reply.message, reply.createdAt || new Date());
      });

      const result = await client.query(
        `
        INSERT INTO quick_replies (shortcut, message, created_at)
        VALUES ${values.join(",")}
        RETURNING *
        `,
        params
      );

      saved = saved.concat(result.rows.map(mapReply));
    }

    await client.query("COMMIT");
    return saved;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
