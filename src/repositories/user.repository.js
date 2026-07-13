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
    // 2FA — nunca expor totpSecret/totpPendingSecret/totpBackupCodes fora do
    // backend (ver twoFactor.service.js e o sanitizeUser() das rotas).
    totpSecret: row.totp_secret,
    totpPendingSecret: row.totp_pending_secret,
    totpEnabled: row.totp_enabled,
    totpBackupCodes: row.totp_backup_codes,
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

// Reativa um usuário previamente excluído (ativo=false) em vez de criar uma
// linha nova — necessário porque "usuario" tem UNIQUE NOT NULL no schema e
// deactivate() nunca apaga a linha de verdade (soft delete), então um INSERT
// com o mesmo "usuario" sempre bateria nessa constraint.
async function reactivate(id, user) {
  const result = await pool.query(
    `
    UPDATE users
    SET nome     = $1,
        senha    = $2,
        perfil   = $3,
        sector   = $4,
        numero   = $5,
        foto     = $6,
        ativo    = TRUE,
        updated_at = NOW()
    WHERE id = $7
    RETURNING *
    `,
    [
      user.nome,
      user.senha,
      user.perfil,
      user.sector,
      user.numero || "",
      user.foto || "",
      id
    ]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
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

// ─── 2FA (TOTP) ────────────────────────────────────────────────────────────

/** Guarda o segredo gerado no setup, ainda não confirmado/ativo. */
async function setTotpPendingSecret(id, secret) {
  await pool.query(
    `UPDATE users SET totp_pending_secret = $1, updated_at = NOW() WHERE id = $2`,
    [secret, id]
  );
}

/** Confirma o setup: pending vira secret ativo, salva os códigos de backup (hash). */
async function enableTotp(id, secret, backupCodeHashes) {
  const result = await pool.query(
    `
    UPDATE users
    SET totp_secret = $1,
        totp_pending_secret = NULL,
        totp_enabled = TRUE,
        totp_backup_codes = $2::jsonb,
        updated_at = NOW()
    WHERE id = $3
    RETURNING *
    `,
    [secret, JSON.stringify(backupCodeHashes), id]
  );

  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

/** Desliga o 2FA e limpa segredo/pendência/backup codes. */
async function disableTotp(id) {
  await pool.query(
    `
    UPDATE users
    SET totp_secret = NULL,
        totp_pending_secret = NULL,
        totp_enabled = FALSE,
        totp_backup_codes = NULL,
        updated_at = NOW()
    WHERE id = $1
    `,
    [id]
  );
}

/** Substitui a lista de backup codes restantes (após consumir um). */
async function updateBackupCodes(id, remainingHashes) {
  await pool.query(
    `UPDATE users SET totp_backup_codes = $1::jsonb, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(remainingHashes), id]
  );
}

module.exports = {
  findAll,
  countActiveAdmins,
  findById,
  findByUsername,
  create,
  reactivate,
  updateProfile,
  updatePassword,
  deactivate,
  setTotpPendingSecret,
  enableTotp,
  disableTotp,
  updateBackupCodes
};
