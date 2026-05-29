const crypto = require("crypto");
const ticketRepository = require("../repositories/ticket.repository");
const logger = require("../utils/logger");

const TYPE_TO_SECTOR = {
  duvida_financeira: "financeiro",
  atendente_financeiro: "financeiro",
  consultor_vendas: "vendas",
  orcamento: "vendas",
  suporte_tecnico: "suporte",
  suporte_humano: "suporte",
  garantia: "garantia",
  atendente_humano: "geral"
};

async function createTicket({
  userId,
  type,
  customerName,
  cpf,
  description
}) {
  const protocolo = await ticketRepository.gerarProtocolo();
  const sector = TYPE_TO_SECTOR[type] ?? "geral";

  const ticket = {
    id: crypto.randomUUID(),
    protocolo,
    userId,
    type,
    customerName: customerName || "Não informado",
    cpf: cpf || "Não informado",
    description: description || "",
    status: "aberto",
    sector,
    assignedTo: null,
    assignedToName: null,
    createdAt: new Date()
  };

  const criado = await ticketRepository.create(ticket);

  logger.info(`Ticket criado: #${criado.protocolo} (${type})`);

  return criado;
}

async function listTickets({ status, search } = {}) {
  return ticketRepository.findAll({ status, search });
}

async function updateTicketStatus(id, status) {
  return ticketRepository.updateStatus(id, status);
}

async function getTicketStats() {
  return ticketRepository.stats();
}

async function getTicketsByCPF(cpf) {
  const tickets = await ticketRepository.findAll();
  const cpfLimpo = String(cpf || "").replace(/\D/g, "");

  return tickets.filter(t => {
    const cpfTicket = String(t.cpf || "").replace(/\D/g, "");
    return cpfTicket === cpfLimpo;
  });
}

async function assignTicket(id, user) {
  return ticketRepository.assign(id, user);
}

async function transferTicket(id, sector) {
  return ticketRepository.transfer(id, sector);
}

module.exports = {
  createTicket,
  listTickets,
  updateTicketStatus,
  assignTicket,
  transferTicket,
  getTicketStats,
  getTicketsByCPF
};