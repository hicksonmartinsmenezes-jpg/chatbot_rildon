const crypto = require("crypto");
const pool = require("../database/postgres");

async function gerarProtocolo() {
  const ano = new Date().getFullYear();

  const result = await pool.query(`
    SELECT nextval('protocolo_seq') AS numero
  `);

  const numero = result.rows[0].numero;

  return `${ano}-${String(numero).padStart(4, "0")}`;
}

async function create(ticket) {
  const id = ticket.id || crypto.randomUUID();

  const result = await pool.query(
    `
    INSERT INTO tickets (
      id,
      protocolo,
      user_id,
      customer_name,
      cpf,
      type,
      sector,
      description,
      status,
      assigned_to,
      assigned_to_name,
      created_at,
      updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
    )
    RETURNING *
    `,
    [
      id,
      ticket.protocolo,
      ticket.userId,
      ticket.customerName,
      ticket.cpf,
      ticket.type,
      ticket.sector,
      ticket.description,
      ticket.status || "aberto",
      ticket.assignedTo || null,
      ticket.assignedToName || null,
      ticket.createdAt || new Date(),
      ticket.updatedAt || null
    ]
  );

  return mapTicket(result.rows[0]);
}

async function findAll({ status, search } = {}) {
  const values = [];
  const where = [];

  if (status) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search.toLowerCase()}%`);

    where.push(`
      (
        LOWER(user_id) LIKE $${values.length}
        OR LOWER(type) LIKE $${values.length}
        OR LOWER(description) LIKE $${values.length}
        OR LOWER(customer_name) LIKE $${values.length}
        OR LOWER(protocolo) LIKE $${values.length}
      )
    `);
  }

  const query = `
    SELECT *
    FROM tickets
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
  `;

  const result = await pool.query(query, values);

  return result.rows.map(mapTicket);
}

async function updateStatus(id, status) {
  const result = await pool.query(
    `
    UPDATE tickets
    SET status = $1,
        updated_at = NOW()
    WHERE id::text = $2 OR protocolo = $2
    RETURNING *
    `,
    [status, String(id)]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function assign(id, user) {
  const result = await pool.query(
    `
    UPDATE tickets
    SET assigned_to = $1,
        assigned_to_name = $2,
        status = 'em_andamento',
        updated_at = NOW()
    WHERE id::text = $3 OR protocolo = $3
    RETURNING *
    `,
    [
      user.id,
      user.nome || user.usuario,
      String(id)
    ]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function transfer(id, sector) {
  const result = await pool.query(
    `
    UPDATE tickets
    SET sector = $1,
        assigned_to = NULL,
        assigned_to_name = NULL,
        status = 'aberto',
        updated_at = NOW()
    WHERE id::text = $2 OR protocolo = $2
    RETURNING *
    `,
    [sector, String(id)]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function stats() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'aberto')::int AS aberto,
      COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS em_andamento,
      COUNT(*) FILTER (WHERE status = 'resolvido')::int AS resolvido,
      COUNT(*) FILTER (WHERE status = 'cancelado')::int AS cancelado
    FROM tickets
  `);

  return result.rows[0];
}

function mapTicket(row) {
  return {
    id: row.id,
    protocolo: row.protocolo,
    userId: row.user_id,
    customerName: row.customer_name,
    cpf: row.cpf,
    type: row.type,
    sector: row.sector,
    description: row.description,
    status: row.status,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function findByCpf(cpfLimpo) {
  const result = await pool.query(
    `SELECT * FROM tickets WHERE REGEXP_REPLACE(cpf, '\\D', '', 'g') = $1 ORDER BY created_at DESC`,
    [cpfLimpo]
  );
  return result.rows.map(mapTicket);
}

module.exports = {
  create,
  findAll,
  findByCpf,
  updateStatus,
  assign,
  transfer,
  stats,
  gerarProtocolo
};