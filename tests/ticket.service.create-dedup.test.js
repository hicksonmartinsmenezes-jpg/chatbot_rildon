/**
 * Testes de createTicket (ticket.service.js) — guard contra ticket
 * duplicado pro mesmo cliente.
 *
 * BUG CORRIGIDO (relatado pelo usuário: "cliquei em aceitar e ficou em
 * pendentes o pedido, cliquei em fechar e foi pra ativos"): o bot continua
 * respondendo normalmente enquanto um ticket criado espera um atendente
 * aceitar (humanMode só pausa o bot DEPOIS do "Aceitar" — ver
 * assumirTicket em ticket.controller.js). Se o cliente manda outro pedido
 * nesse meio-tempo, o fluxo (vendas.flow/crediario.flow/main.flow) criava
 * um ticket NOVO em paralelo pro mesmo cliente. O painel só guarda "um
 * ticket mais recente por cliente" (ticketsByUser no frontend) — com dois
 * tickets ativos ao mesmo tempo, qual deles é "o mais recente" mudava
 * conforme o status de cada um mudava, e os botões Aceitar/Fechar
 * acabavam agindo no ticket que NÃO estava na tela.
 *
 * createTicket agora checa se já existe um ticket ATIVO (aberto ou
 * em_andamento) pro mesmo cliente antes de criar um novo — se existir,
 * reaproveita (anexando a nova descrição) em vez de duplicar.
 */
jest.mock("../src/repositories/ticket.repository", () => ({
  gerarProtocolo: jest.fn(),
  create: jest.fn(),
  findByUserIds: jest.fn(),
  prependDescription: jest.fn(),
}));
jest.mock("../src/whatsapp/lid-map", () => ({
  getProfilePhotoCandidates: jest.fn(userId => [userId]),
}));
jest.mock("../src/services/session.service", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({}),
}));
// Pedido do usuário (2026-07-24): createTicket agora chama marcarComoCliente
// (contacts.service.js) pra promover "Clientes Novos" → "Clientes". Sem
// mock, esse dependeria de um banco real (contacts.service usa pool.query
// direto) — mockado aqui pra manter o teste isolado/rápido.
jest.mock("../src/services/contacts.service", () => ({
  marcarComoCliente: jest.fn().mockResolvedValue(undefined),
}));

const ticketRepository = require("../src/repositories/ticket.repository");
const { marcarComoCliente } = require("../src/services/contacts.service");
const { createTicket } = require("../src/services/ticket.service");

const USER_ID = "5511999999999@s.whatsapp.net";

function ticketAtivo(overrides = {}) {
  return {
    id: 70,
    protocolo: "2026-0070",
    userId: USER_ID,
    status: "aberto",
    description: "Veículo: Fiat Uno 2025 | Produto: Palheta",
    ...overrides,
  };
}

describe("createTicket — evita ticket duplicado pro mesmo cliente", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sem ticket ativo existente → cria normalmente", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([]);
    ticketRepository.gerarProtocolo.mockResolvedValue("2026-0099");
    ticketRepository.create.mockResolvedValue({ id: 99, protocolo: "2026-0099", status: "aberto" });

    const ticket = await createTicket({ userId: USER_ID, type: "orcamento", description: "Motor de partida" });

    expect(ticketRepository.create).toHaveBeenCalledTimes(1);
    expect(ticketRepository.prependDescription).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({ id: 99 });
  });

  test("já existe ticket 'aberto' pro cliente → reaproveita, anexa descrição, não cria outro", async () => {
    const ativo = ticketAtivo({ status: "aberto" });
    ticketRepository.findByUserIds.mockResolvedValue([ativo]);
    ticketRepository.prependDescription.mockResolvedValue({
      ...ativo,
      description: "Motor de partida\n---\n(pedido anterior) " + ativo.description,
    });

    const ticket = await createTicket({ userId: USER_ID, type: "orcamento", description: "Motor de partida" });

    expect(ticketRepository.create).not.toHaveBeenCalled();
    expect(ticketRepository.prependDescription).toHaveBeenCalledWith(70, "Motor de partida");
    expect(ticket.protocolo).toBe("2026-0070");
    expect(ticket.description).toContain("Motor de partida");
  });

  test("já existe ticket 'em_andamento' pro cliente → reaproveita também (não só 'aberto')", async () => {
    const ativo = ticketAtivo({ status: "em_andamento" });
    ticketRepository.findByUserIds.mockResolvedValue([ativo]);
    ticketRepository.prependDescription.mockResolvedValue(ativo);

    await createTicket({ userId: USER_ID, type: "orcamento", description: "Farol" });

    expect(ticketRepository.create).not.toHaveBeenCalled();
    expect(ticketRepository.prependDescription).toHaveBeenCalledWith(70, "Farol");
  });

  test("ticket existente 'resolvido'/'cancelado' NÃO conta como ativo — cria normalmente (mesmo comportamento de sempre)", async () => {
    const fechado = ticketAtivo({ status: "resolvido" });
    ticketRepository.findByUserIds.mockResolvedValue([fechado]);
    ticketRepository.gerarProtocolo.mockResolvedValue("2026-0100");
    ticketRepository.create.mockResolvedValue({ id: 100, protocolo: "2026-0100", status: "aberto" });

    const ticket = await createTicket({ userId: USER_ID, type: "orcamento", description: "Amortecedor" });

    expect(ticketRepository.create).toHaveBeenCalledTimes(1);
    expect(ticketRepository.prependDescription).not.toHaveBeenCalled();
    expect(ticket).toMatchObject({ id: 100 });
  });

  test("ticket ativo existente sem description no novo pedido → reaproveita sem chamar prependDescription", async () => {
    const ativo = ticketAtivo({ status: "aberto" });
    ticketRepository.findByUserIds.mockResolvedValue([ativo]);

    const ticket = await createTicket({ userId: USER_ID, type: "orcamento" });

    expect(ticketRepository.prependDescription).not.toHaveBeenCalled();
    expect(ticketRepository.create).not.toHaveBeenCalled();
    expect(ticket).toBe(ativo);
  });

  // Pedido do usuário (2026-07-24): "só cadastre Clientes quando gerarem
  // tickets" — createTicket sempre promove o contato, tanto criando um
  // ticket novo quanto reaproveitando um já ativo (as duas situações
  // significam "esse cliente gerou um atendimento").
  test("gerar ticket novo chama marcarComoCliente com o userId", async () => {
    ticketRepository.findByUserIds.mockResolvedValue([]);
    ticketRepository.gerarProtocolo.mockResolvedValue("2026-0101");
    ticketRepository.create.mockResolvedValue({ id: 101, protocolo: "2026-0101", status: "aberto" });

    await createTicket({ userId: USER_ID, type: "orcamento", description: "Vela de ignição" });

    expect(marcarComoCliente).toHaveBeenCalledWith(USER_ID);
  });

  test("reaproveitar ticket ativo também chama marcarComoCliente com o userId", async () => {
    const ativo = ticketAtivo({ status: "em_andamento" });
    ticketRepository.findByUserIds.mockResolvedValue([ativo]);
    ticketRepository.prependDescription.mockResolvedValue(ativo);

    await createTicket({ userId: USER_ID, type: "orcamento", description: "Correia" });

    expect(marcarComoCliente).toHaveBeenCalledWith(USER_ID);
  });
});
