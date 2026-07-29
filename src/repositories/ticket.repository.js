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

async function updateStatus(id, status, { resetSatisfaction = true } = {}) {
  const idStr = String(id);

  // BUG CORRIGIDO: reabrir um ticket (status → "aberto") — seja pelo cliente
  // mandando mensagem de novo via reopenTicketIfClosed(), seja pelo atendente
  // clicando em "Reabrir" — só atualizava o status, sem limpar assigned_to/
  // assigned_to_name do atendimento ANTERIOR. Resultado: o ticket reaberto
  // aparecia como "aberto"/pendente na lista, mas internamente continuava
  // "pertencendo" a quem o atendeu da última vez — então assign() sempre
  // recusava com "já foi assumido por <nome antigo>", mesmo sem ninguém ter
  // assumido de fato desta vez. Ao reabrir, o atendimento é conceitualmente
  // novo: ninguém deveria estar com ele até alguém clicar Assumir de novo.
  // (Fechar o ticket, resolvido/cancelado, continua preservando
  // assigned_to_name de propósito — é usado para estatísticas/histórico de
  // quem atendeu, ex. dashboard "porAtendente".)
  //
  // BUG CORRIGIDO (relatado pelo usuário, achado ao testar o fix da
  // pesquisa em dobro): satisfaction_asked_at nunca era limpo ao reabrir —
  // então um cliente atendido, fechado e reaberto (novo episódio de
  // atendimento) NUNCA mais recebia a pesquisa de satisfação depois da
  // 1ª vez, porque o guard atômico em askSatisfaction via
  // satisfaction_asked_at já preenchido pra sempre. Reabrir também zera os
  // campos de satisfação — é um atendimento novo, deve poder gerar uma
  // pesquisa nova quando fechar de novo.
  //
  // BUG CORRIGIDO (relatado pelo usuário, 2026-07-24): o fix acima resolvia
  // o caso de reabertura MANUAL (atendente clica "Reabrir" em Fechados,
  // possivelmente dias depois — aí sim é um atendimento novo de verdade),
  // mas a reabertura AUTOMÁTICA (reopenTicketIfClosed, cliente manda
  // mensagem de novo dentro da janela de poucos minutos/hora —
  // TICKET_REOPEN_WINDOW_MINUTOS) usa o MESMO updateStatus e sempre zerava
  // satisfaction_asked_at também — fazendo a saudação do atendente
  // (enviarSaudacaoAtendente, que usa satisfactionAskedAt como sinal de "já
  // teve um ciclo completo recente" — ver assumirTicket) e a pesquisa de
  // satisfação dispararem de novo pra uma reabertura de segundos/minutos
  // depois, que é a MESMA conversa continuando, não um atendimento novo.
  // O parâmetro resetSatisfaction permite ao chamador (ticket.service.js/
  // reopenTicketIfClosed) preservar os campos de satisfação nesse caso
  // específico, mantendo o reset completo só na reabertura manual (chamada
  // sem esse parâmetro, default true — comportamento de sempre).
  const reabrindo = status === "aberto";
  const zerarSatisfacao = reabrindo && resetSatisfaction;

  const result = await pool.query(
    `
    UPDATE tickets
    SET status = $1,
        updated_at = NOW()
        ${reabrindo ? ", assigned_to = NULL, assigned_to_name = NULL" : ""}
        ${zerarSatisfacao ? ", satisfaction_rating = NULL, satisfaction_asked_at = NULL, satisfaction_rated_at = NULL" : ""}
    WHERE ${idOrProtocolWhere(idStr, 2)}
    RETURNING *
    `,
    [status, idStr]
  );

  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

async function assign(id, user) {
  const idStr = String(id);

  // Verifica se o ticket existe antes de tentar assumir. Também traz
  // assigned_to_name aqui: se já estiver atribuído, o controller usa esse
  // nome para informar ao atendente QUEM já assumiu, em vez de uma
  // mensagem genérica de "já foi assumido por outro atendente".
  const exists = await pool.query(
    `SELECT id, assigned_to, assigned_to_name FROM tickets WHERE ${idOrProtocolWhere(idStr, 1)}`,
    [idStr]
  );
  if (!exists.rows[0]) return { notFound: true };
  if (exists.rows[0].assigned_to) {
    return { alreadyAssigned: true, assignedToName: exists.rows[0].assigned_to_name || null };
  }

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

  if (result.rows[0]) return mapTicket(result.rows[0]);

  // Corrida: outro atendente assumiu entre o SELECT de cima e este UPDATE
  // (0 linhas afetadas). Busca de novo só para informar quem venceu a corrida.
  const winner = await pool.query(
    `SELECT assigned_to_name FROM tickets WHERE ${idOrProtocolWhere(idStr, 1)}`,
    [idStr]
  );
  return { alreadyAssigned: true, assignedToName: winner.rows[0]?.assigned_to_name || null };
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
    updatedAt: row.updated_at,
    // Pesquisa de satisfação (migration 015) — ver askSatisfaction/rateSatisfaction.
    satisfactionRating: row.satisfaction_rating ?? null,
    satisfactionAskedAt: row.satisfaction_asked_at ?? null,
    satisfactionRatedAt: row.satisfaction_rated_at ?? null,
    // Feedback livre em nota baixa (migration 018) — ver saveSatisfactionFeedback.
    satisfactionFeedback: row.satisfaction_feedback ?? null,
    satisfactionFeedbackAt: row.satisfaction_feedback_at ?? null
  };
}

async function findByUserId(userId) {
  const result = await pool.query(
    `SELECT * FROM tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  return result.rows.map(mapTicket);
}

async function findByUserIds(userIds) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length) return [];
  const result = await pool.query(
    `SELECT * FROM tickets WHERE user_id = ANY($1) ORDER BY created_at DESC LIMIT 20`,
    [ids]
  );
  return result.rows.map(mapTicket);
}

// Marca a pesquisa de satisfação como enviada (chamado ao fechar o
// ticket). satisfaction_asked_at é o que define "pesquisa pendente" em
// message.service.js — sem tabela nova, o próprio ticket carrega o estado.
//
// BUG CORRIGIDO (relatado pelo usuário): existem DOIS botões de "fechar"
// no painel (lista de tickets em 06-tickets.js e a tela de conversa em
// 07-conversations.js), cada um disparando seu próprio PATCH — se dois
// cliques (em qualquer combinação dos dois botões, ou 2 abas abertas)
// chegassem quase juntos, ambas as requisições liam o ticket como "ainda
// não resolvido" ANTES de qualquer uma commitar (race de leitura-antes-
// de-escrever), e as duas mandavam a pesquisa de satisfação — cliente
// recebia "De 1 a 5..." duas vezes. A trava no frontend (runExclusive)
// ajuda, mas não fecha a race entre abas/dispositivos diferentes — a
// garantia real precisa estar no banco. "AND satisfaction_asked_at IS
// NULL" faz esse UPDATE ser a reivindicação atômica: só a requisição que
// realmente conseguir gravar a linha (RETURNING não vazio) é que deve
// mandar a mensagem — ver enviarPesquisaSatisfacao em ticket.controller.js.
async function askSatisfaction(id) {
  const idStr = String(id);
  const result = await pool.query(
    `
    UPDATE tickets
    SET satisfaction_asked_at = NOW()
    WHERE ${idOrProtocolWhere(idStr, 1)} AND satisfaction_asked_at IS NULL
    RETURNING *
    `,
    [idStr]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

// Registra a nota (1-5) respondida pelo cliente.
async function rateSatisfaction(id, rating) {
  const idStr = String(id);
  const result = await pool.query(
    `
    UPDATE tickets
    SET satisfaction_rating = $1, satisfaction_rated_at = NOW()
    WHERE ${idOrProtocolWhere(idStr, 2)}
    RETURNING *
    `,
    [rating, idStr]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

// Registra o texto livre de "o que podemos melhorar?" — só perguntado
// quando a nota (rateSatisfaction acima) foi baixa (ver
// SATISFACTION_LOW_THRESHOLD em ticket.service.js).
async function saveSatisfactionFeedback(id, feedback) {
  const idStr = String(id);
  const result = await pool.query(
    `
    UPDATE tickets
    SET satisfaction_feedback = $1, satisfaction_feedback_at = NOW()
    WHERE ${idOrProtocolWhere(idStr, 2)}
    RETURNING *
    `,
    [feedback, idStr]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
}

// Anexa uma nova descrição a um ticket ATIVO já existente, em vez de criar
// um segundo ticket para o mesmo cliente (ver createTicket em
// ticket.service.js — o bot continua respondendo normalmente enquanto o
// ticket espera um atendente aceitar, então um 2º pedido nesse meio-tempo
// virava um ticket duplicado, confundindo qual ticket os botões Aceitar/
// Fechar do painel deviam afetar). O texto novo entra NO TOPO (o pedido
// mais recente é o relevante pra mensagem de confirmação ao cliente,
// ORCAMENTO_SOLICITADO, que só lê a 1ª ocorrência de "Produto:"/"Veículo:"
// na descrição) — o texto anterior fica preservado logo abaixo, como
// histórico, para o atendente ver os dois pedidos.
async function prependDescription(id, novoTexto) {
  const idStr = String(id);
  const result = await pool.query(
    `
    UPDATE tickets
    SET description = CASE
          WHEN description IS NULL OR description = '' THEN $1::text
          ELSE $1::text || E'\n---\n(pedido anterior) ' || description
        END,
        updated_at = NOW()
    WHERE ${idOrProtocolWhere(idStr, 2)}
    RETURNING *
    `,
    [novoTexto, idStr]
  );
  return result.rows[0] ? mapTicket(result.rows[0]) : null;
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
  findByUserIds,
  findByIdOrProtocol,
  updateStatus,
  assign,
  transfer,
  stats,
  gerarProtocolo,
  askSatisfaction,
  rateSatisfaction,
  saveSatisfactionFeedback,
  prependDescription
};
