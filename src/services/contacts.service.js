const pool   = require("../database/postgres");
const logger = require("../utils/logger");

async function listContacts({ page = 1, limit = 40, search = "", status = "", tag = "", atendenteId = "" } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  const where  = [];

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(c.nome) LIKE $${params.length} OR c.whatsapp LIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    where.push(`c.status = $${params.length}`);
  }
  if (tag) {
    params.push(tag);
    where.push(`$${params.length} = ANY(c.tags)`);
  }
  if (atendenteId) {
    params.push(atendenteId);
    where.push(`c.atendente_id = $${params.length}`);
  }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await pool.query(
    `SELECT COUNT(*) FROM contacts c ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0].count);

  params.push(limit, offset);
  const dataRes = await pool.query(
    `SELECT c.*,
            u.nome AS atendente_nome
     FROM contacts c
     LEFT JOIN users u ON u.id = c.atendente_id
     ${whereClause}
     ORDER BY lower(c.nome) ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { total, page, limit, rows: dataRes.rows };
}

async function getContact(id) {
  const res = await pool.query(
    `SELECT c.*, u.nome AS atendente_nome
     FROM contacts c
     LEFT JOIN users u ON u.id = c.atendente_id
     WHERE c.id = $1`,
    [id]
  );
  if (!res.rows.length) throw new Error("Contato não encontrado.");
  return res.rows[0];
}

async function createContact({ nome, whatsapp, estado, status = "ativo", tags = [], atendenteId, departamento }) {
  if (!nome || !whatsapp) throw new Error("Nome e WhatsApp são obrigatórios.");

  const digits = String(whatsapp).replace(/\D/g, "");
  if (!digits) throw new Error("WhatsApp inválido.");

  const existing = await pool.query(`SELECT id FROM contacts WHERE whatsapp = $1`, [digits]);
  if (existing.rows.length) throw new Error("Já existe um contato com este WhatsApp.");

  const res = await pool.query(
    `INSERT INTO contacts (nome, whatsapp, estado, status, tags, atendente_id, departamento)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [nome.trim(), digits, estado || null, status, tags, atendenteId || null, departamento || null]
  );
  return res.rows[0];
}

async function updateContact(id, { nome, whatsapp, estado, status, tags, atendenteId, departamento }) {
  const fields = [];
  const params = [];

  if (nome !== undefined)        { params.push(nome.trim());              fields.push(`nome = $${params.length}`); }
  if (whatsapp !== undefined)    { params.push(String(whatsapp).replace(/\D/g, "")); fields.push(`whatsapp = $${params.length}`); }
  if (estado !== undefined)      { params.push(estado || null);           fields.push(`estado = $${params.length}`); }
  if (status !== undefined)      { params.push(status);                   fields.push(`status = $${params.length}`); }
  if (tags !== undefined)        { params.push(tags);                     fields.push(`tags = $${params.length}`); }
  if (atendenteId !== undefined) { params.push(atendenteId || null);      fields.push(`atendente_id = $${params.length}`); }
  if (departamento !== undefined){ params.push(departamento || null);     fields.push(`departamento = $${params.length}`); }

  if (!fields.length) throw new Error("Nenhum campo para atualizar.");

  fields.push(`updated_at = NOW()`);
  params.push(id);

  const res = await pool.query(
    `UPDATE contacts SET ${fields.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!res.rows.length) throw new Error("Contato não encontrado.");
  return res.rows[0];
}

async function deleteContact(id) {
  const res = await pool.query(`DELETE FROM contacts WHERE id = $1 RETURNING id`, [id]);
  if (!res.rows.length) throw new Error("Contato não encontrado.");
  return { ok: true };
}

async function deleteContacts(ids) {
  if (!Array.isArray(ids) || !ids.length) throw new Error("Informe ao menos um ID.");
  const res = await pool.query(
    `DELETE FROM contacts WHERE id = ANY($1::uuid[]) RETURNING id`,
    [ids]
  );
  return { deleted: res.rowCount };
}

async function importContacts(rows) {
  let inserted = 0;
  let skipped  = 0;

  for (const row of rows) {
    const digits = String(row.whatsapp || "").replace(/\D/g, "");
    if (!row.nome || !digits) { skipped++; continue; }

    const exists = await pool.query(`SELECT id FROM contacts WHERE whatsapp = $1`, [digits]);
    if (exists.rows.length) { skipped++; continue; }

    await pool.query(
      `INSERT INTO contacts (nome, whatsapp, estado, status, tags, departamento)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [row.nome.trim(), digits, row.estado || null, row.status || "ativo",
       row.tags ? row.tags.split(";").map(t => t.trim()).filter(Boolean) : [],
       row.departamento || null]
    );
    inserted++;
  }

  logger.info(`[Contacts] Import: ${inserted} inseridos, ${skipped} ignorados.`);
  return { inserted, skipped };
}

async function getAllTags() {
  const res = await pool.query(
    `SELECT DISTINCT unnest(tags) AS tag FROM contacts WHERE array_length(tags, 1) > 0 ORDER BY tag`
  );
  return res.rows.map(r => r.tag);
}

module.exports = {
  listContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  deleteContacts,
  importContacts,
  getAllTags
};
