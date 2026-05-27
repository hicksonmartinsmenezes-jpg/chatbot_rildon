const {
  listTickets,
  updateTicketStatus,
  getTicketStats,
  assignTicket,
  transferTicket
} = require("../services/ticket.service");

async function getTickets(req, res) {
  const { status, search } = req.query;

  let tickets = await listTickets({ status, search });

  // FILTRO POR PERFIL
if (req.user?.perfil === "atendente") {

  tickets = tickets.filter(ticket => {

    const mesmoSetor =
      (ticket.sector || "geral") ===
      (req.user.sector || "geral");

    const disponivel =
      !ticket.assignedTo;

    const jaAssumidoPorEle =
      ticket.assignedTo === req.user.id;

    return (
      (mesmoSetor && disponivel) ||
      jaAssumidoPorEle
    );

  });

}

  const stats = await getTicketStats();

  res.json({
    stats,
    total: tickets.length,
    tickets
  });
}

async function patchTicket(req, res) {
  const id = req.params.id;
  const { status } = req.body;

  const allowed = [
    "aberto",
    "em_andamento",
    "resolvido",
    "cancelado"
  ];

  if (!allowed.includes(status)) {
    return res.status(400).json({
      error: `Status inválido. Use: ${allowed.join(", ")}`
    });
  }

  const ticket = await updateTicketStatus(id, status);

  if (!ticket) {
    return res.status(404).json({
      error: "Ticket não encontrado."
    });
  }

  res.json({
    message: "Status atualizado.",
    ticket
  });
}

async function assumirTicket(req, res) {
  const id = req.params.id;

  const ticket = await assignTicket(id, req.user);

  if (!ticket) {
    return res.status(404).json({
      error: "Ticket não encontrado."
    });
  }

  res.json({
    ok: true,
    ticket
  });
}

async function transferirTicket(req, res) {
  const id = req.params.id;
  const { sector } = req.body || {};

  if (!sector) {
    return res.status(400).json({
      error: "Setor é obrigatório."
    });
  }

  const ticket = await transferTicket(id, sector);

  if (!ticket) {
    return res.status(404).json({
      error: "Ticket não encontrado."
    });
  }

  res.json({
    ok: true,
    ticket
  });
}

async function getTicketDashboard(req, res) {
  const tickets = await listTickets();

  const porStatus = {
    aberto: tickets.filter(t => t.status === "aberto").length,
    em_andamento: tickets.filter(t => t.status === "em_andamento").length,
    resolvido: tickets.filter(t => t.status === "resolvido").length,
    cancelado: tickets.filter(t => t.status === "cancelado").length
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

  const hoje = new Date().toISOString().slice(0, 10);

  const hojeTotal = tickets.filter(t =>
    String(t.createdAt || "").startsWith(hoje)
  ).length;

  res.json({
    total: tickets.length,
    hoje: hojeTotal,
    porStatus,
    porSetor,
    porAtendente
  });
}



module.exports = {
  getTickets,
  patchTicket,
  assumirTicket,
  transferirTicket,
  getTicketDashboard
};
