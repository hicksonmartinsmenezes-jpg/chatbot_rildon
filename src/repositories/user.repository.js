const pool = require("../database/postgres");

function mapUser(row) {
  return {
    id: row.id,
    nome: row.nome,
    usuario: row.usuario,
    senha: row.senha,
    perfil: row.perfil,
    sector: row.sector,
    numero: row.numero,
    foto: row.foto,
    ativo: row.ativo,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findById(id) {
  const result = await pool.query(
    `SELECT * FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

async function findAll({ includeInactive = false } = {}) {
  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE ($1::boolean = true OR ativo = true)
    ORDER BY nome ASC
    `,
    [includeInactive]
  );

  return result.rows.map(mapUser);
}

async function countActiveAdmins() {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM users
    WHERE ativo = true AND perfil = 'admin'
    `
  );

  return Number(result.rows[0]?.total || 0);
}

async function findByUsername(usuario) {
  const result = await pool.query(
    `
    SELECT *
    FROM users
    WHERE LOWER(usuario) = LOWER($1)
    LIMIT 1
    `,
    [usuario]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

async function create(user) {
  const result = await pool.query(
    `
    INSERT INTO users (
      id, nome, usuario, senha, perfil,
      sector, numero, foto, ativo
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
    `,
    [
      user.id,
      user.nome,
      user.usuario,
      user.senha,
      user.perfil,
      user.sector,
      user.numero || "",
      user.foto || "",
      user.ativo
    ]
  );

  return mapUser(result.rows[0]);
}

async function updateProfile(id, data) {
  const result = await pool.query(
    `
    UPDATE users
    SET nome = $1,
        numero = $2,
        foto = $3,
        updated_at = NOW()
    WHERE id = $4
    RETURNING *
    `,
    [data.nome, data.numero, data.foto, id]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

async function updatePassword(id, senhaHash) {
  const result = await pool.query(
    `
    UPDATE users
    SET senha = $1,
        updated_at = NOW()
    WHERE id = $2
    RETURNING *
    `,
    [senhaHash, id]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

async function deactivate(id) {
  const result = await pool.query(
    `
    UPDATE users
    SET ativo = false,
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [id]
  );

  return result.rows[0]
    ? mapUser(result.rows[0])
    : null;
}

module.exports = {
  findAll,
  countActiveAdmins,
  findById,
  findByUsername,
  create,
  updateProfile,
  updatePassword,
  deactivate
};