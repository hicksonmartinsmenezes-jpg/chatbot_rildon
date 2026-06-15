const logger = require("../utils/logger");
const {
  createTicket,
  listTickets,
  updateTicketStatus,
  getTicketStats,
  assignTicket,
  transferTicket
} = require("../services/ticket.service");

// CORRIGIDO: "atendimento" adicionado — mainFlow cria tickets com esse setor
const SETORES_VALIDOS = [
  "suporte", "vendas", "financeiro", "garantia", "geral", "atendimento", "gestao"
];

const STATUS_VALIDOS = ["aberto", "em_andamento", "resolvido", "cancelado"];

async function postTicket(req, res) {
  try {
    const { userId, type, customerName, cpf, description, sector } = req.body || {};

    // CORRIGIDO: validação de campos obrigatórios
    if (!userId) {
      return res.status(400).json({ error: "userId é obrigatório." });
    }
    if (!type) {
      return res.status(400).json({ error: "type é obrigatório." });
    }

    const ticket = await createTicket({ userId, type, customerName, cpf, description, sector });

    res.status(201).json({ ok: true, ticket });
  } catch (err) {
    logger.error(`[postTicket] ${err.message}`);
    res.status(400).json({ error: err.message || "Erro ao criar ticket." });
  }
}

async function getTickets(req, res) {
  try {
    const { status, search, dateStart, dateEnd } = req.query;

    // CORRIGIDO: validação de status antes de passar ao repositório
    if (status && !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({
        error: `Status inválido. Use: ${STATUS_VALIDOS.join(", ")}`
      });
    }

    let tickets = await listTickets({ status, search, dateStart, dateEnd });

    if (req.user?.perfil === "atendente") {
      tickets = tickets.filter(ticket => {
        const mesmoSetor = (ticket.sector || "geral") === (req.user.sector || "geral");
        const disponivel  = !ticket.assignedTo;
        const jaAssumido  = ticket.assignedTo === req.user.id;
        return (mesmoSetor && disponivel) || jaAssumido;
      });
    }

    const stats     = await getTicketStats({ dateStart, dateEnd });
    const liveStats = await getTicketStats({}); // sem filtro de data = estado atual real

    res.json({ stats, liveStats, total: tickets.length, tickets });
  } catch (err) {
    logger.error(`[getTickets] ${err.message}`);
    res.status(500).json({ error: "Erro ao listar tickets." });
  }
}

async function patchTicket(req, res) {
  try {
    const id = req.params.id;

    // CORRIGIDO: garante que status é string antes de incluir
    const status = typeof req.body?.status === "string" ? req.body.status : "";

    if (!STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({
        error: `Status inválido. Use: ${STATUS_VALIDOS.join(", ")}`
      });
    }

    const ticket = await updateTicketStatus(id, status);

    if (!ticket) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }

    res.json({ message: "Status atualizado.", ticket });
  } catch (err) {
    logger.error(`[patchTicket] ${err.message}`);
    res.status(500).json({ error: "Erro ao atualizar ticket." });
  }
}

async function assumirTicket(req, res) {
  try {
    const id = req.params.id;

    const ticket = await assignTicket(id, req.user);

    if (!ticket) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }

    res.json({ ok: true, ticket });
  } catch (err) {
    logger.error(`[assumirTicket] ${err.message}`);
    res.status(500).json({ error: "Erro ao assumir ticket." });
  }
}

async function transferirTicket(req, res) {
  try {
    const id = req.params.id;
    const { sector } = req.body || {};

    if (!sector) {
      return res.status(400).json({ error: "Setor é obrigatório." });
    }

    if (!SETORES_VALIDOS.includes(sector.toLowerCase())) {
      return res.status(400).json({
        error: `Setor inválido. Use: ${SETORES_VALIDOS.join(", ")}`
      });
    }

    const ticket = await transferTicket(id, sector.toLowerCase());

    if (!ticket) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }

    res.json({ ok: true, ticket });
  } catch (err) {
    logger.error(`[transferirTicket] ${err.message}`);
    res.status(500).json({ error: "Erro ao transferir ticket." });
  }
}

// CORRIGIDO: dashboard calculado em SQL via getTicketStats() + query dedicada
// em vez de carregar todos os tickets em memória e calcular em JS
async function getTicketDashboard(req, res) {
  try {
    const pool = require("../database/postgres");
    // Timezone configurável via .env para evitar hardcode por região
    const TZ = process.env.TZ_NEGOCIO || "America/Maceio";

    const [statsRes, setorRes, atendenteRes, hojeRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'aberto')::int       AS aberto,
          COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS em_andamento,
          COUNT(*) FILTER (WHERE status = 'resolvido')::int    AS resolvido,
          COUNT(*) FILTER (WHERE status = 'cancelado')::int    AS cancelado
        FROM tickets
      `),
      pool.query(`
        SELECT COALESCE(sector,'geral') AS setor, COUNT(*)::int AS total
        FROM tickets
        GROUP BY setor
        ORDER BY total DESC
      `),
      pool.query(`
        SELECT assigned_to_name AS nome, COUNT(*)::int AS total
        FROM tickets
        WHERE assigned_to_name IS NOT NULL
        GROUP BY assigned_to_name
        ORDER BY total DESC
      `),
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM tickets
        WHERE DATE(created_at AT TIME ZONE $1) = CURRENT_DATE
      `, [TZ])
    ]);

    const s = statsRes.rows[0];

    const porSetor = {};
    for (const row of setorRes.rows) porSetor[row.setor] = row.total;

    const porAtendente = {};
    for (const row of atendenteRes.rows) porAtendente[row.nome] = row.total;

    res.json({
      total: s.total,
      hoje: hojeRes.rows[0].total,
      porStatus: {
        aberto:       s.aberto,
        em_andamento: s.em_andamento,
        resolvido:    s.resolvido,
        cancelado:    s.cancelado
      },
      porSetor,
      porAtendente
    });
  } catch (err) {
    logger.error(`[getTicketDashboard] ${err.message}`);
    res.status(500).json({ error: "Erro ao gerar dashboard." });
  }
}

module.exports = {
  postTicket,
  getTickets,
  patchTicket,
  assumirTicket,
  transferirTicket,
  getTicketDashboard
};
