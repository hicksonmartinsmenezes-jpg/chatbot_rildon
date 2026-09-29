/**
 * Testes de reopenTicketIfClosed — janela de tempo pro reopen (pedido do
 * usuário: "toda vez que encerrar atendimento, se o cliente quiser ser
 * atendido novamente, criar ticket novo?").
 *
 * Decisão (discutida com o usuário): não é all-or-nothing. Reabre o MESMO
 * ticket só se o fechamento foi recente (TICKET_REOPEN_WINDOW_MINUTOS,
 * padrão 240min/4h — pedido do usuário em 2026-09-19, era 60min) — cobre o
 * caso real de atendimento encerrado por engano
 * (timeout de inatividade) e o cliente responder minutos depois. Fora da
 * janela, retorna false e o fluxo normal (main.flow.js) cria um ticket novo
 * naturalmente quando o cliente pedir algo — sem reciclar um protocolo
 * antigo pra um assunto sem relação, dias/semanas depois.
 */
jest.mock("../src/repositories/ticket.repository", () => ({
  findByUserIds: jest.fn(),
  updateStatus: jest.fn(),
}));
jest.mock("../src/whatsapp/lid-map", () => ({
  getProfilePhotoCandidates: jest.fn(userId => [userId]),
}));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({ atendimento: {} }),
}));

const ticketRepository = require("../src/repositories/ticket.repository");
const { emitEvent } = require("../src/services/socket.service");
const { reopenTicketIfClosed, clearReopenCooldown } = require("../src/services/ticket.service");

function ticketFechado(minutosAtras, overrides = {}) {
  return {
    id: 42,
    protocolo: "2026-0042",
    userId: "cliente-1",
    status: "resolvido",
    updatedAt: new Date(Date.now() - minutosAtras * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe("reopenTicketIfClosed — janela de tempo (TICKET_REOPEN_WINDOW_MINUTOS)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearReopenCooldown("cliente-1");
  });

  test("fechado há 5 minutos (dentro da janela padrão de 240min/4h) → reabre o mesmo ticket", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([ticketFechado(5)]);
    ticketRepository.updateStatus.mockResolvedValue({ id: 42, status: "aberto" });

    const resultado = await reopenTicketIfClosed("cliente-1");

    expect(resultado).toBe(true);
    // Pedido do usuário (2026-07-24): reabertura AUTOMÁTICA preserva os
    // campos de satisfação (resetSatisfaction:false) — é a mesma conversa
    // continuando, não um atendimento novo. Ver ticket.repository.test.js
    // e assumirTicket (ticket.controller.js) pro resto do fix.
    expect(ticketRepository.updateStatus).toHaveBeenCalledWith(42, "aberto", { resetSatisfaction: false });
    expect(emitEvent).toHaveBeenCalledWith("ticket_atualizado", expect.anything());
  });

  test("fechado há 3 dias (bem fora da janela) → NÃO reabre, deixa o fluxo normal criar ticket novo", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([ticketFechado(3 * 24 * 60)]);

    const resultado = await reopenTicketIfClosed("cliente-1");

    expect(resultado).toBe(false);
    expect(ticketRepository.updateStatus).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  test("fechado exatamente no limite da janela (239min) ainda reabre", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([ticketFechado(239)]);
    ticketRepository.updateStatus.mockResolvedValue({ id: 42, status: "aberto" });

    const resultado = await reopenTicketIfClosed("cliente-1");

    expect(resultado).toBe(true);
  });

  test("ticket ainda aberto/em_andamento (não fechado) → segue lógica normal, sem checar janela", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([ticketFechado(9999, { status: "em_andamento" })]);

    const resultado = await reopenTicketIfClosed("cliente-1");

    // Não está fechado — nada a reabrir, mas não é o caminho de "fora da janela"
    expect(resultado).toBe(false);
    expect(ticketRepository.updateStatus).not.toHaveBeenCalled();
  });

  test("cancelado (não só resolvido) também respeita a janela", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([ticketFechado(3 * 24 * 60, { status: "cancelado" })]);

    const resultado = await reopenTicketIfClosed("cliente-1");

    expect(resultado).toBe(false);
    expect(ticketRepository.updateStatus).not.toHaveBeenCalled();
  });
});
