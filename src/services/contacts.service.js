const pool          = require("../database/postgres");
const logger        = require("../utils/logger");
const { emitEvent } = require("./socket.service");

// Tags de cliente/estágio — controladas pelo próprio sistema, não aparecem
// como checkbox no editar contato do painel (pedido do usuário, 2026-07-24):
// todo contato criado via autoRegisterContact (1ª mensagem no WhatsApp,
// ver src/whatsapp/contacts.js) nasce como "Clientes Novos"; quando ele gera
// o 1º ticket de verdade (createTicket, ticket.service.js), marcarComoCliente()
// abaixo promove pra "Clientes" — a etiqueta de "novo" sai, "cliente" fica.
const TAG_CLIENTE      = "Clientes";
const TAG_CLIENTE_NOVO = "Clientes Novos";

// Promove um contato de "Clientes Novos" para "Clientes" quando ele gera um
// ticket — chamado por ticket.service.js/createTicket. Idempotente (não faz
// nada se o contato já tiver a tag "Clientes" ou não existir ainda).
async function marcarComoCliente(userIdOuTelefone) {
  const digits = String(userIdOuTelefone || "")
    .replace(/@(s\.whatsapp\.net|lid)$/i, "")
    .replace(/\D/g, "");
  if (!digits) return;

  try {
    const res = await pool.query(
      `SELECT id, tags FROM contacts WHERE whatsapp = $1 LIMIT 1`,
      [digits]
    );
    if (!res.rows.length) return;

    const contato = res.rows[0];
    const tagsAtuais = Array.isArray(contato.tags) ? contato.tags : [];
    if (tagsAtuais.includes(TAG_CLIENTE)) return;

    const novasTags = [...tagsAtuais.filter(t => t !== TAG_CLIENTE_NOVO), TAG_CLIENTE];
    await pool.query(
      `UPDATE contacts SET tags = $1::text[], updated_at = NOW() WHERE id = $2`,
      [novasTags, contato.id]
    );
    logger.info(`[Contacts] ${digits} promovido a "${TAG_CLIENTE}" (gerou ticket)`);
    emitEvent("contacts_updated", { reason: "ticket_gerado", whatsapp: digits });
  } catch (err) {
    logger.warn(`[marcarComoCliente] ${err.message}`);
  }
}

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
  const totalRows = Array.isArray(rows) ? rows.length : 0;
  if (!totalRows) return { inserted: 0, skipped: 0 };

  // 1. Normaliza e valida
  const normalized = [];
  for (const row of rows) {
    const digits = String(row.whatsapp || "").replace(/\D/g, "");
    if (!row.nome || !digits) continue;
    normalized.push({
      nome:         String(row.nome).trim(),
      whatsapp:     digits,
      estado:       row.estado || null,
      status:       row.status || "ativo",
      tags:         row.tags ? String(row.tags).split(";").map(t => t.trim()).filter(Boolean) : [],
      departamento: row.departamento || null,
    });
  }
  if (!normalized.length) return { inserted: 0, skipped: totalRows };

  // 2. Dedup dentro do próprio arquivo (mantém o primeiro de cada whatsapp)
  const byPhone = new Map();
  for (const r of normalized) if (!byPhone.has(r.whatsapp)) byPhone.set(r.whatsapp, r);
  const unique = [...byPhone.values()];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 3. Descobre quais já existem no banco — uma única query
    const phones   = unique.map(r => r.whatsapp);
    const existRes = await client.query(
      `SELECT whatsapp FROM contacts WHERE whatsapp = ANY($1::text[])`,
      [phones]
    );
    const existing = new Set(existRes.rows.map(r => r.whatsapp));
    const toInsert = unique.filter(r => !existing.has(r.whatsapp));

    // 4. Inserção em lote, em chunks (limite de ~65k parâmetros do PostgreSQL)
    const CHUNK = 500;
    for (let i = 0; i < toInsert.length; i += CHUNK) {
      const slice  = toInsert.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      slice.forEach((r, j) => {
        const b = j * 6;
        values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`);
        params.push(r.nome, r.whatsapp, r.estado, r.status, r.tags, r.departamento);
      });
      await client.query(
        `INSERT INTO contacts (nome, whatsapp, estado, status, tags, departamento)
         VALUES ${values.join(",")}`,
        params
      );
    }

    await client.query("COMMIT");

    const inserted = toInsert.length;
    const skipped  = totalRows - inserted;
    logger.info(`[Contacts] Import: ${inserted} inseridos, ${skipped} ignorados.`);
    return { inserted, skipped };
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error(`[Contacts] Import falhou (rollback): ${err.message}`);
    throw err;
  } finally {
    client.release();
  }
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
  getAllTags,
  marcarComoCliente,
  TAG_CLIENTE,
  TAG_CLIENTE_NOVO
};
