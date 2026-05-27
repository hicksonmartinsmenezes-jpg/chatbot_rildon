const pool = require("../database/postgres");

async function get(key) {
  const result = await pool.query(
    `
    SELECT *
    FROM settings
    WHERE key = $1
    LIMIT 1
    `,
    [key]
  );

  if (!result.rows[0]) {
    return null;
  }

  try {
    return JSON.parse(result.rows[0].value);
  } catch {
    return result.rows[0].value;
  }
}

async function set(key, value) {
  const jsonValue = JSON.stringify(value);

  const result = await pool.query(
    `
    INSERT INTO settings (
      key,
      value,
      created_at,
      updated_at
    )
    VALUES ($1,$2,NOW(),NOW())
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    RETURNING *
    `,
    [key, jsonValue]
  );

  try {
    return JSON.parse(result.rows[0].value);
  } catch {
    return result.rows[0].value;
  }
}

module.exports = {
  get,
  set
};