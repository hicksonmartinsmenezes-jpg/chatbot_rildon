/**
 * Testes de message.service.js — foco na interceptação da resposta de
 * pesquisa de satisfação (pedido do usuário: "uma pesquisa de satisfação ao
 * fechar atendimento?"). handleSatisfactionReply() precisa ser checado ANTES
 * de reopenTicketIfClosed() dentro de processMessage() — senão a própria
 * resposta do cliente (ex: "5") reabriria um ticket já fechado como se fosse
 * um pedido novo, em vez de só registrar a nota (ver nota em
 * src/services/ticket.service.js). Esse é o teste mais importante desta
 * suíte: cobre o pipeline central de TODA mensagem recebida pelo bot, então
 * qualquer regressão aqui afeta produção diretamente.
 */
jest.mock("../src/flows/main.flow", () => jest.fn());
jest.mock("../src/services/history.service", () => ({ saveHistory: jest.fn().mockResolvedValue({ id: "h1" }) }));
jest.mock("../src/services/queue.service", () => ({
  enqueue: jest.fn((userId, task) => task())
}));
jest.mock("../src/services/session.service", () => ({ getSession: jest.fn().mockReturnValue({}) }));
jest.mock("../src/services/botConfig.service", () => ({ getBotConfig: jest.fn().mockResolvedValue({ ativo: true }) }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/ticket.service", () => ({
  reopenTicketIfClosed: jest.fn().mockResolvedValue(false),
  handleSatisfactionReply: jest.fn().mockResolvedValue(null)
}));
jest.mock("../src/services/humanMode.service", () => ({ estaAtivo: jest.fn().mockReturnValue(false) }));

const mainFlow = require("../src/flows/main.flow");
const { saveHistory } = require("../src/services/history.service");
const { emitEvent } = require("../src/services/socket.service");
const ticketService = require("../src/services/ticket.service");
const humanMode = require("../src/services/humanMode.service");
const { processMessage } = require("../src/services/message.service");

describe("processMessage — pesquisa de satisfação", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketService.reopenTicketIfClosed.mockResolvedValue(false);
    ticketService.handleSatisfactionReply.mockResolvedValue(null);
    humanMode.estaAtivo.mockReturnValue(false);
    mainFlow.mockResolvedValue("resposta normal do bot");
  });

  test("nota de satisfação pendente e reconhecida → responde agradecimento e NÃO reabre ticket nem chama o fluxo do bot", async () => {
    ticketService.handleSatisfactionReply.mockResolvedValueOnce({
      ticket: { id: 42 },
      rating: 5,
      response: "Muito obrigado pela sua avaliação!"
    });

    const resposta = await processMessage({
      userId: "cliente-1",
      contactName: "Cliente",
      message: "5",
      messageId: "wamid-1"
    });

    expect(resposta).toBe("Muito obrigado pela sua avaliação!");
    expect(ticketService.reopenTicketIfClosed).not.toHaveBeenCalled();
    expect(mainFlow).not.toHaveBeenCalled();
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "cliente-1", sector: "pesquisa_satisfacao", response: "Muito obrigado pela sua avaliação!" })
    );
    expect(emitEvent).toHaveBeenCalledWith(
      "nova_mensagem",
      expect.objectContaining({ userId: "cliente-1", sector: "pesquisa_satisfacao" })
    );
  });

  test("sem pesquisa pendente → segue o fluxo normal (reabre ticket se preciso, chama o bot)", async () => {
    const resposta = await processMessage({
      userId: "cliente-2",
      contactName: "Cliente",
      message: "Olá, preciso de ajuda",
      messageId: "wamid-2"
    });

    expect(ticketService.reopenTicketIfClosed).toHaveBeenCalledWith("cliente-2");
    expect(mainFlow).toHaveBeenCalled();
    expect(resposta).toBe("resposta normal do bot");
  });

  test("erro ao checar pesquisa de satisfação não derruba o fluxo normal (best-effort)", async () => {
    ticketService.handleSatisfactionReply.mockRejectedValueOnce(new Error("DB indisponível"));

    const resposta = await processMessage({
      userId: "cliente-3",
      contactName: "Cliente",
      message: "Olá",
      messageId: "wamid-3"
    });

    expect(ticketService.reopenTicketIfClosed).toHaveBeenCalledWith("cliente-3");
    expect(mainFlow).toHaveBeenCalled();
    expect(resposta).toBe("resposta normal do bot");
  });

  test("modo humano ativo + pesquisa pendente → ainda assim responde a pesquisa (curto-circuito acontece antes do check de humanMode)", async () => {
    humanMode.estaAtivo.mockReturnValue(true);
    ticketService.handleSatisfactionReply.mockResolvedValueOnce({
      ticket: { id: 42 },
      rating: 3,
      response: "Muito obrigado pela sua avaliação!"
    });

    const resposta = await processMessage({
      userId: "cliente-4",
      contactName: "Cliente",
      message: "3",
      messageId: "wamid-4"
    });

    expect(resposta).toBe("Muito obrigado pela sua avaliação!");
    expect(mainFlow).not.toHaveBeenCalled();
  });
});
