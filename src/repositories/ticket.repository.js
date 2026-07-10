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
  const result = await pool.query(
    `
    INSERT INTO tickets (
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
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
    )
    RETURNING *
    `,
    [
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
      ticket.updatedAt || new Date()
    ]
  );

  return mapTicket(result.rows[0]);
}

// Valida timezone para evitar injeção SQL via variável de ambiente
const _VALID_TZ_RE = /^[A-Za-z_/]+$/;
function safeTZ() {
  const tz = process.env.TZ_NEGOCIO || "";
  return _VALID_TZ_RE.test(tz) ? tz : "America/Maceio";
}

// Detecta se o valor parece o id numérico de tickets (id é SERIAL/integer —
// ver schema.sql; NÃO é uuid, ao contrário de users/contacts). Usado para
// montar o WHERE de busca por id-ou-protocolo SEM fazer cast na coluna
// "id" (id::text = $1) — esse cast, usado antes aqui, invalida o índice da
// chave primária e força sequential scan em toda busca/assumir/transferir/
// atualizar status de ticket. Comparando "id = $N::int" (cast no parâmetro,
// não na coluna) o Postgres consegue usar o índice normalmente.
//
// BUG CORRIGIDO (1): a versão anterior testava formato UUID (_UUID_RE), mas
// tickets.id é inteiro — então NUNCA batia, e toda busca por id caía no
// branch "protocolo = $N" comparando um número (ex. "42") contra a coluna
// protocolo (formato "2026-0042"), que nunca é igual. Resultado: assumir,
// transferir e fechar ticket por id retornavam 404 sistematicamente, para
// qualquer perfil (a checagem de permissão nem chegava a rodar). Os testes
// não pegaram isso porque as fixtures usavam UUIDs fabricados em vez de
// inteiros reais — corrigido junto com este fix.
//
// BUG CORRIGIDO (2): a correção acima trocou para "(id = $N::int OR
// protocolo = $N)", mas deixou a segunda ocorrência de $N sem cast. O
// Postgres resolve o TIPO de um parâmetro nomeado uma única vez por
// statement — como a primeira ocorrência fixa $N como "int" (por causa do
// "::int"), a segunda ocorrência ("protocolo = $N", sem cast) tenta comparar
// a coluna varchar "protocolo" com um valor já tipado como integer, e o
// Postgres não tem operador "character varying = integer" → erro em
// runtime (500) em toda chamada, mesmo com o dado correto. Corrigido dando
// cast explícito também na segunda ocorrência ("::text"), o que não muda o
// comportamento (protocolo nunca é numérico puro) mas evita o conflito de
// tipos do parâmetro compartilhado.
const _INTEGER_RE = /^\d+$/;

function idOrProtocolWhere(value, paramIndex) {
  return _INTEGER_RE.test(value)
    ? `(id = $${paramIndex}::int OR protocolo = $${paramIndex}::text)`
    : `protocolo = $${paramIndex}`;
}

async function findAll({ status, search, dateStart, dateEnd, limit = 500, offset = 0 } = {}) {
  const TZ = safeTZ();
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

  if (dateStart) {
    values.push(dateStart);
    where.push(`DATE(created_at AT TIME ZONE '${TZ}') >= $${values.length}::date`);
  }

  if (dateEnd) {
    values.push(dateEnd);
    where.push(`DATE(created_at AT TIME ZONE '${TZ}') <= $${values.length}::date`);
  }

  values.push(limit);
  values.push(offset);

  const query = `
    SELECT *
    FROM tickets
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `;

  const result = await pool.query(query, values);

  return result.rows.map(mapTicket);
}

async function findByIdOrProtocol(id) {
  const idStr = String(id);
  const result = await pool.query(
    `SELECT * FROM tickets WHERE ${idOrProtocolWhere(idStr, 1)} LIMIT 1`,
    [idStr]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function updateStatus(id, status) {
  const idStr = String(id);
  const result = await pool.query(
    `
    UPDATE tickets
    SET status = $1,
        updated_at = NOW()
    WHERE ${idOrProtocolWhere(idStr, 2)}
    RETURNING *
    `,
    [status, idStr]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function assign(id, user) {
  const idStr = String(id);

  // Verifica se o ticket existe antes de tentar assumir
  const exists = await pool.query(
    `SELECT id, assigned_to FROM tickets WHERE ${idOrProtocolWhere(idStr, 1)}`,
    [idStr]
  );
  if (!exists.rows[0]) return { notFound: true };
  if (exists.rows[0].assigned_to) return { alreadyAssigned: true };

  const result = await pool.query(
    `
   UPDATE tickets
    SET assigned_to = $1,
        assigned_to_name = $2,
        status = 'em_andamento',
        updated_at = NOW()
    WHERE
    ${idOrProtocolWhere(idStr, 3)}
    AND assigned_to IS NULL
    RETURNING *
    `,
    [
      user.id,
      user.nome || user.usuario,
      idStr
    ]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : { alreadyAssigned: true };
}

async function transfer(id, sector, targetUser = null) {
  const idStr = String(id);
  const newSector      = targetUser?.sector || sector;
  const assignedTo     = targetUser?.id     || null;
  const assignedToName = targetUser ? (targetUser.nome || targetUser.usuario) : null;
  const newStatus      = targetUser ? "em_andamento" : "aberto";

  const result = await pool.query(
    `
    UPDATE tickets
    SET sector           = $1,
        assigned_to      = $2,
        assigned_to_name = $3,
        status           = $4,
        updated_at       = NOW()
    WHERE ${idOrProtocolWhere(idStr, 5)}
    RETURNING *
    `,
    [newSector, assignedTo, assignedToName, newStatus, idStr]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function stats({ dateStart, dateEnd } = {}) {
  const TZ = safeTZ();
  const values = [];
  const where = [];

  if (dateStart) {
    values.push(dateStart);
    where.push(`DATE(created_at AT TIME ZONE '${TZ}') >= $${values.length}::date`);
  }

  if (dateEnd) {
    values.push(dateEnd);
    where.push(`DATE(created_at AT TIME ZONE '${TZ}') <= $${values.length}::date`);
  }

  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'aberto')::int AS aberto,
      COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS em_andamento,
      COUNT(*) FILTER (WHERE status = 'resolvido')::int AS resolvido,
      COUNT(*) FILTER (WHERE status = 'cancelado')::int AS cancelado
    FROM tickets
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
  `, values);

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

async function findByUserId(userId) {
  const result = await pool.query(
    `SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  return result.rows.map(mapTicket);
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
  findByUserId,
  findByIdOrProtocol,
  updateStatus,
  assign,
  transfer,
  stats,
  gerarProtocolo
};
