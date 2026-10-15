/** GET /api/tickets: o parâmetro ?limit precisa chegar no repositório (com teto). */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/config/whatsapp", () => ({ sendMessage: jest.fn(), getConnectionInfo: jest.fn().mockReturnValue({ connected: true }) }));
jest.mock("../src/repositories/user.repository", () => ({ findById: jest.fn() }));
jest.mock("../src/services/settings.service", () => ({ getSettings: jest.fn().mockResolvedValue({}) }));
jest.mock("../src/services/ticket.service", () => ({
  createTicket: jest.fn(),
  listTickets: jest.fn().mockResolvedValue([]),
  updateTicketStatus: jest.fn(),
  clearReopenCooldown: jest.fn(),
  foiReabertoManualmenteRecente: jest.fn(),
  getTicketStats: jest.fn().mockResolvedValue({ total: 0 }),
  getTicketsEncerradosNoPeriodo: jest.fn().mockResolvedValue(0),
  assignTicket: jest.fn(),
  transferTicket: jest.fn()
}));
jest.mock("../src/services/humanMode.service", () => ({ ativar: jest.fn(), desativar: jest.fn(), estaAtivo: jest.fn() }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/audit.service", () => ({ auditLog: jest.fn() }));
jest.mock("../src/whatsapp/contacts", () => ({ buscarNomeContatoReal: jest.fn(), contatoTemTagFuncionario: jest.fn() }));
jest.mock("../src/whatsapp/lid-map", () => ({ getProfilePhotoCandidates: jest.fn((id) => [id]) }));
jest.mock("../src/repositories/ticket.repository", () => ({ findByIdOrProtocol: jest.fn(), findByUserIds: jest.fn() }));

const express = require("express");
const request = require("supertest");
const ticketService = require("../src/services/ticket.service");
const ticketRoutes = require("../src/routes/ticket.routes");

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = { id: "1", nome: "Ana", perfil: "admin" }; next(); });
  a.use("/api", ticketRoutes);
  return a;
}

describe("GET /api/tickets — limite", () => {
  beforeEach(() => jest.clearAllMocks());

  test("repassa o limit pedido", async () => {
    await request(app()).get("/api/tickets?limit=5000");
    expect(ticketService.listTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000 }));
  });

  test("corta no teto de 5000", async () => {
    await request(app()).get("/api/tickets?limit=99999");
    expect(ticketService.listTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: 5000 }));
  });

  test("sem limit, deixa o padrão do repositório (undefined)", async () => {
    await request(app()).get("/api/tickets");
    expect(ticketService.listTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });

  test("limit inválido não vira NaN", async () => {
    await request(app()).get("/api/tickets?limit=abc");
    expect(ticketService.listTickets).toHaveBeenCalledWith(expect.objectContaining({ limit: undefined }));
  });
});
