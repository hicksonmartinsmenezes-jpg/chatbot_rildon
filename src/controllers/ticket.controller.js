const logger = require("../utils/logger");
const {
  listTickets,
  updateTicketStatus,
  getTicketStats,
  assignTicket,
  transferTicket
} = require("../services/ticket.service");

const SETORES_VALIDOS = ["suporte", "vendas", "financeiro", "garantia", "geral", "atendimento"];

async function getTickets(req, res) {
  try {
    const { status, search } = req.query;

    let tickets = await listTickets({ status, search });

    // Filtro por perfil: atendente vê somente o seu setor
    if (req.user?.perfil === "atendente") {
      tickets = tickets.filter(ticket => {
        const mesmoSetor    = (ticket.sector || "geral") === (req.user.sector || "geral");
        const disponivel    = !ticket.assignedTo;
        const jaAssumido    = ticket.assignedTo === req.user.id;
        return (mesmoSetor && disponivel) || jaAssumido;
      });
    }

    const stats = await getTicketStats();

    res.json({ stats, total: tickets.length, tickets });
  } catch (err) {
    logger.error(`[getTickets] ${err.message}`);
    res.status(500).json({ error: "Erro ao listar tickets." });
  }
}

async function patchTicket(req, res) {
  try {
    const id = req.params.id;
    const { status } = req.body;

    const allowed = ["aberto", "em_andamento", "resolvido", "cancelado"];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Status inválido. Use: ${allowed.join(", ")}`
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

async function getTicketDashboard(req, res) {
  try {
    const tickets = await listTickets();
    const hoje = new Date().toISOString().slice(0, 10);

    const porStatus = {
      aberto:       tickets.filter(t => t.status === "aberto").length,
      em_andamento: tickets.filter(t => t.status === "em_andamento").length,
      resolvido:    tickets.filter(t => t.status === "resolvido").length,
      cancelado:    tickets.filter(t => t.status === "cancelado").length
    };

    const porSetor = tickets.reduce((acc, ticket) => {
      const setor = ticket.sector || ticket.type || "geral";
      acc[setor] = (acc[setor] || 0) + 1;
      return acc;
    }, {});

    const porAtendente = tickets.reduce((acc, ticket) => {
      if (!ticket.assignedToName) return acc;
      acc[ticket.assignedToName] = (acc[ticket.assignedToName] || 0) + 1;
      return acc;
    }, {});

    // Filtra tickets criados hoje comparando só a data local (não ISO string)
    const hojeTotal = tickets.filter(t => {
      if (!t.createdAt) return false;
      return new Date(t.createdAt).toISOString().slice(0, 10) === hoje;
    }).length;

    res.json({
      total: tickets.length,
      hoje: hojeTotal,
      porStatus,
      porSetor,
      porAtendente
    });
  } catch (err) {
    logger.error(`[getTicketDashboard] ${err.message}`);
    res.status(500).json({ error: "Erro ao gerar dashboard." });
  }
}

module.exports = {
  getTickets,
  patchTicket,
  assumirTicket,
  transferirTicket,
  getTicketDashboard
};
