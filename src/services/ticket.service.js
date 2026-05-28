const crypto = require("crypto");
const ticketRepository = require("../repositories/ticket.repository");
const logger = require("../utils/logger");
const { Mutex } = require("async-mutex");

const TYPE_TO_SECTOR = {
  duvida_financeira:    "financeiro",
  atendente_financeiro: "financeiro",
  consultor_vendas:     "vendas",
  orcamento:            "vendas",
  suporte_tecnico:      "suporte",
  suporte_humano:       "suporte",   // FIX: tipo que existia nos flows mas faltava no mapa
  garantia:             "garantia",
  atendente_humano:     "geral",     // FIX: idem
};

// FIX: mutex para evitar protocolos duplicados quando dois usuários abrem ticket ao mesmo tempo
const _protocolMutex = new Mutex();

async function proximoProtocolo() {
  return _protocolMutex.runExclusive(async () => {
    const ano = new Date().getFullYear();
    const tickets = await ticketRepository.findAll();
    const ticketsDoAno = tickets.filter(t =>
      String(t.protocolo || "").startsWith(String(ano))
    );
    const seq = ticketsDoAno.length + 1;
    return `${ano}-${String(seq).padStart(4, "0")}`;
  });
}

async function createTicket({ userId, type, customerName, cpf, description }) {
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
    createdAt: new Date(),
  };

  const criado = await ticketRepository.create(ticket);
  // FIX: removido console.log de produção; substituído por logger
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
  const cpfLimpo = cpf.replace(/\D/g, "");
  return tickets.filter(t => t.cpf && t.cpf.replace(/\D/g, "") === cpfLimpo);
}

async function assignTicket(id, user) {
  return ticketRepository.assign(id, user);
}

async function transferTicket(id, sector) {
  return ticketRepository.transfer(id, sector);
}

module.exports = {
  createTicket, listTickets, updateTicketStatus,
  assignTicket, transferTicket, getTicketStats, getTicketsByCPF,
};
