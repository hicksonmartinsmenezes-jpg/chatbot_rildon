const crypto = require("crypto");
const ticketRepository = require("../repositories/ticket.repository");

const TYPE_TO_SECTOR = {
  duvida_financeira: "financeiro",
  atendente_financeiro: "financeiro",
  consultor_vendas: "vendas",
  orcamento: "vendas",
  suporte_tecnico: "suporte",
  garantia: "garantia"
};

async function proximoProtocolo() {
  const ano = new Date().getFullYear();

  const tickets = await ticketRepository.findAll();

  const ticketsDoAno = tickets.filter(ticket =>
    String(ticket.protocolo || "").startsWith(String(ano))
  );

  const seq = ticketsDoAno.length + 1;

  return `${ano}-${String(seq).padStart(4, "0")}`;
}

async function createTicket({
  userId,
  type,
  customerName,
  cpf,
  description
}) {
  const protocolo = await proximoProtocolo();

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

  return ticketRepository.create(ticket);
}

async function listTickets({ status, search } = {}) {
  return ticketRepository.findAll({
    status,
    search
  });
}

async function updateTicketStatus(id, status) {
  return ticketRepository.updateStatus(id, status);
}

async function getTicketStats() {
  return ticketRepository.stats();
}

async function getTicketsByCPF(cpf) {
  const tickets = await ticketRepository.findAll();

  const cpfLimpo = cpf.replace(/\D/g, "");

  return tickets.filter(ticket =>
    ticket.cpf &&
    ticket.cpf.replace(/\D/g, "") === cpfLimpo
  );
}

async function assignTicket(id, user) {
  return ticketRepository.assign(id, user);
}

async function transferTicket(id, sector) {
  return ticketRepository.transfer(id, sector);
}

console.log("📦 PostgreSQL: tickets carregados");

module.exports = {
  createTicket,
  listTickets,
  updateTicketStatus,
  assignTicket,
  transferTicket,
  getTicketStats,
  getTicketsByCPF
};