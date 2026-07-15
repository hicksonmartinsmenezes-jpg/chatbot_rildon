/**
 * Testes de parseSatisfactionRating/handleSatisfactionReply (ticket.service.js)
 * — pesquisa de satisfação automática ao fechar um atendimento (pedido do
 * usuário: "uma pesquisa de satisfação ao fechar atendimento?", nota de 1 a
 * 5). handleSatisfactionReply é chamado por message.service.js ANTES de
 * reopenTicketIfClosed, pra que a resposta do cliente ("5") não seja
 * confundida com um pedido novo — ver tests/message.service.test.js para a
 * integração completa no pipeline de mensagens.
 *
 * parseSatisfactionRating é testado isoladamente (função pura); os testes de
 * handleSatisfactionReply mockam ticketRepository/settings/lid-map.
 */
jest.mock("../src/repositories/ticket.repository", () => ({
  findByUserIds: jest.fn(),
  rateSatisfaction: jest.fn()
}));
jest.mock("../src/whatsapp/lid-map", () => ({
  getProfilePhotoCandidates: jest.fn(userId => [userId])
}));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    atendimento: { mensagemAgradecimentoPesquisa: "Muito obrigado pela sua avaliação!" }
  })
}));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));

const ticketRepository = require("../src/repositories/ticket.repository");
const settingsService = require("../src/services/settings.service");
const { parseSatisfactionRating, handleSatisfactionReply } = require("../src/services/ticket.service");

function ticketPendente(overrides = {}) {
  return {
    id: 42,
    protocolo: "2026-0042",
    userId: "cliente-1",
    status: "resolvido",
    satisfactionRating: null,
    satisfactionAskedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("parseSatisfactionRating", () => {
  test.each([
    ["5", 5],
    ["nota 5", 5],
    ["5/5", 5],
    ["5 estrelas", 5],
    ["1", 1],
    [" 3 ", 3]
  ])("reconhece nota válida em %j", (texto, esperado) => {
    expect(parseSatisfactionRating(texto)).toBe(esperado);
  });

  test.each([
    ["0"],       // fora do range 1-5
    ["6"],       // fora do range 1-5
    ["55"],      // dois dígitos adjacentes — não é uma nota isolada
    [""],
    [null],
    [undefined],
    ["1".repeat(31)] // texto longo demais (>30 chars) mesmo contendo dígito válido
  ])("NÃO reconhece nota em %j", (texto) => {
    expect(parseSatisfactionRating(texto)).toBeNull();
  });

  // Caso real que motivou o limite de 30 chars: um CPF digitado por engano
  // não pode ser lido como nota só porque contém um dígito 1-5 em algum lugar.
  test("não confunde um CPF longo (com dígito 1-5 no meio) com uma nota", () => {
    expect(parseSatisfactionRating("123.456.789-01 (esse é meu CPF)")).toBeNull();
  });
});

describe("handleSatisfactionReply", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsService.getSettings.mockResolvedValue({
      atendimento: { mensagemAgradecimentoPesquisa: "Muito obrigado pela sua avaliação!" }
    });
  });

  test("sem ticket resolvido pendente → retorna null e não grava nota", async () => {
    ticketRepository.findByUserIds.mockResolvedValueOnce([]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("pesquisa pendente + nota válida → registra e retorna agradecimento", async () => {
    const pendente = ticketPendente();
    ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);
    ticketRepository.rateSatisfaction.mockResolvedValueOnce({ ...pendente, satisfactionRating: 5 });

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(ticketRepository.rateSatisfaction).toHaveBeenCalledWith(42, 5);
    expect(res).toMatchObject({ rating: 5, response: "Muito obrigado pela sua avaliação!" });
  });

  test("pesquisa pendente mas mensagem NÃO é uma nota reconhecível → retorna null, não grava", async () => {
    const pendente = ticketPendente();
    ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "obrigado pelo atendimento!" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("ticket já avaliado (satisfactionRating preenchido) não conta como pendente", async () => {
    const jaAvaliado = ticketPendente({ satisfactionRating: 4 });
    ticketRepository.findByUserIds.mockResolvedValueOnce([jaAvaliado]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("pesquisa expirada (fora da janela de 48h) não conta como pendente", async () => {
    const antigo = ticketPendente({
      satisfactionAskedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString()
    });
    ticketRepository.findByUserIds.mockResolvedValueOnce([antigo]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("ticket ainda não resolvido (em_andamento) não conta como pendente mesmo com satisfactionAskedAt", async () => {
    const emAndamento = ticketPendente({ status: "em_andamento" });
    ticketRepository.findByUserIds.mockResolvedValueOnce([emAndamento]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
  });
});
