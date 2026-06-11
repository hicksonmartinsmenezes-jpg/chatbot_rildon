const ticketRepository = require("../repositories/ticket.repository");
const logger = require("../utils/logger");

// Cooldown de reabertura: evita reabrir o mesmo ticket múltiplas vezes em rajada
const _reopenCooldown = new Map();
setInterval(() => _reopenCooldown.clear(), 5 * 60 * 1000);

// Mapeamento type → sector. "atendente_humano" agora mapeado explicitamente.
const TYPE_TO_SECTOR = {
  duvida_financeira:   "financeiro",
  atendente_financeiro:"financeiro",
  consultor_vendas:    "vendas",
  orcamento:           "vendas",
  suporte_tecnico:     "suporte",
  suporte_humano:      "suporte",
  garantia:            "garantia",
  // CORRIGIDO: atendente_humano → "atendimento" (consistente com main.flow)
  atendente_humano:    "atendimento"
};

async function createTicket({
  userId,
  type,
  customerName,
  cpf,
  description,
  sector: sectorOverride
}) {
  const protocolo = await ticketRepository.gerarProtocolo();
  const sector = sectorOverride || TYPE_TO_SECTOR[type] || "geral";

  const ticket = {
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
    updatedAt: new Date()
  };

  const criado = await ticketRepository.create(ticket);

  logger.info(`Ticket criado: #${criado.protocolo} (${type}) setor=${sector}`);

  return criado;
}

async function listTickets({ status, search, dateStart, dateEnd } = {}) {
  return ticketRepository.findAll({ status, search, dateStart, dateEnd });
}

async function updateTicketStatus(id, status) {
  return ticketRepository.updateStatus(id, status);
}

async function getTicketStats({ dateStart, dateEnd } = {}) {
  return ticketRepository.stats({ dateStart, dateEnd });
}

async function getTicketsByCPF(cpf) {
  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  if (!cpfLimpo) return [];
  return ticketRepository.findByCpf(cpfLimpo);
}

async function reopenTicketIfClosed(userId) {
  const lastReopen = _reopenCooldown.get(userId);
  if (lastReopen && Date.now() - lastReopen < 60_000) return false;

  const tickets = await ticketRepository.findByUserId(userId);
  if (!tickets.length) return false;
  const latest = tickets[0]; // já ordenado DESC
  if (latest.status === "resolvido" || latest.status === "cancelado") {
    await ticketRepository.updateStatus(latest.id, "aberto");
    _reopenCooldown.set(userId, Date.now());
    logger.info(`Ticket #${latest.protocolo} reaberto para ${userId}`);
    return true;
  }
  return false;
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
  reopenTicketIfClosed,
  assignTicket,
  transferTicket,
  getTicketStats,
  getTicketsByCPF
};
