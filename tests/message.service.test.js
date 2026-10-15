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
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn().mockResolvedValue({ ativo: true }),
  // Mesma lógica de prioridade da implementação real (ver
  // src/services/botConfig.service.js) — duplicada aqui de propósito porque
  // o mock acima substitui o módulo inteiro; mantém os testes de
  // processMessage cobrindo o caminho real de decisão (teste/funcionário).
  resolverBotOffEfetivo: jest.fn(({ ativoFalse, isNumeroTeste = false, isFuncionario = false }) => {
    if (isFuncionario) return true;
    if (ativoFalse && isNumeroTeste) return false;
    return ativoFalse;
  }),
}));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/ticket.service", () => ({
  reopenTicketIfClosed: jest.fn().mockResolvedValue(false),
  handleSatisfactionReply: jest.fn().mockResolvedValue(null),
  pareceEncerramentoPosAvaliacao: jest.fn().mockResolvedValue(false),
  garantirTicketPendente: jest.fn().mockResolvedValue({ criado: true })
}));
jest.mock("../src/services/humanMode.service", () => ({ estaAtivo: jest.fn().mockReturnValue(false) }));

const mainFlow = require("../src/flows/main.flow");
const { saveHistory } = require("../src/services/history.service");
const { emitEvent } = require("../src/services/socket.service");
const ticketService = require("../src/services/ticket.service");
const humanMode = require("../src/services/humanMode.service");
const botConfigService = require("../src/services/botConfig.service");
const { processMessage } = require("../src/services/message.service");

describe("processMessage — pesquisa de satisfação", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketService.reopenTicketIfClosed.mockResolvedValue(false);
    ticketService.handleSatisfactionReply.mockResolvedValue(null);
    ticketService.pareceEncerramentoPosAvaliacao.mockResolvedValue(false);
    humanMode.estaAtivo.mockReturnValue(false);
    botConfigService.getBotConfig.mockResolvedValue({ ativo: true });
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

  // BUG CORRIGIDO (2026-07-23, ticket #2026-0090 em produção): atendente
  // assumia o ticket ENQUANTO mainFlow() já estava processando uma mensagem
  // anterior do mesmo cliente (chamadas de IA levam vários segundos) — o
  // check de humanMode lá no topo já tinha passado (bot ainda não pausado),
  // então o bot respondia por cima do atendente humano segundos depois dele
  // já ter assumido. Corrigido com um segundo check de humanMode.estaAtivo()
  // logo após mainFlow() retornar, antes de salvar/emitir/enviar a resposta.
  test("atendente assume DURANTE o processamento do fluxo → resposta do bot é descartada, não reabre nem envia nada", async () => {
    // 1ª chamada (antes do enqueue): ainda não assumido. 2ª chamada (depois
    // do mainFlow terminar): atendente já assumiu nesse meio-tempo.
    humanMode.estaAtivo
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const resposta = await processMessage({
      userId: "cliente-5",
      contactName: "Cliente",
      message: "mas nao tem nada aqui",
      messageId: "wamid-5"
    });

    expect(mainFlow).toHaveBeenCalled();
    expect(resposta).toBe("");
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "cliente-5", sector: "humano", response: null })
    );
    // Não deve salvar/emitir a resposta do bot ("resposta normal do bot")
    expect(saveHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ response: "resposta normal do bot" })
    );
    expect(emitEvent).not.toHaveBeenCalledWith(
      "nova_mensagem",
      expect.objectContaining({ response: "resposta normal do bot" })
    );
  });

  // BUG CORRIGIDO (2026-07-23, reportado pelo usuário): "meu bot quando
  // desligado, as mensagens e notificações novas simplesmente não aparecem".
  // O check de "bot ativo" curto-circuitava a função ANTES do
  // reopenTicketIfClosed e do emit de "nova_mensagem" — com o bot desligado,
  // a mensagem do cliente nunca era salva nem emitida pro painel, sumindo
  // por completo. Corrigido: bot desligado agora só impede resposta
  // automática, igual ao modo humano — reopen, emit e saveHistory sempre
  // acontecem.
  describe("bot desligado no painel", () => {
    beforeEach(() => {
      botConfigService.getBotConfig.mockResolvedValue({ ativo: false });
    });

    test("mensagem nova → reabre ticket, emite pro painel e salva histórico, mas NÃO chama o fluxo do bot nem responde", async () => {
      const resposta = await processMessage({
        userId: "cliente-6",
        contactName: "Cliente",
        message: "Bom dia",
        messageId: "wamid-6"
      });

      expect(resposta).toBe("");
      expect(mainFlow).not.toHaveBeenCalled();
      expect(ticketService.reopenTicketIfClosed).toHaveBeenCalledWith("cliente-6");
      expect(emitEvent).toHaveBeenCalledWith(
        "nova_mensagem",
        expect.objectContaining({ userId: "cliente-6", message: "Bom dia" })
      );
      expect(saveHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "cliente-6", sector: "bot_desligado", response: null })
      );
    });

    // BUG CORRIGIDO (2026-07-23, reportado pelo usuário): ticket fechado já
    // tinha disparado a pesquisa de satisfação e o bot foi desligado logo
    // depois — o cliente respondia a nota (ex: "5") e nada acontecia, sem
    // agradecimento nem registro da avaliação. handleSatisfactionReply não é
    // "o bot iniciando atendimento novo": só fecha o laço de uma pesquisa que
    // o próprio bot já tinha enviado ANTES de ser desligado (guardada por uma
    // flag de sessão de curta duração — ver ticket.service.js), então
    // precisa continuar rodando mesmo com o bot desligado.
    test("pesquisa de satisfação pendente ainda é checada com o bot desligado", async () => {
      await processMessage({
        userId: "cliente-7",
        contactName: "Cliente",
        message: "5",
        messageId: "wamid-7"
      });

      expect(ticketService.handleSatisfactionReply).toHaveBeenCalledWith({ userId: "cliente-7", message: "5" });
    });

    test("nota de satisfação pendente e reconhecida → responde o agradecimento mesmo com o bot desligado", async () => {
      ticketService.handleSatisfactionReply.mockResolvedValueOnce({
        ticket: { id: 42 },
        rating: 5,
        response: "Muito obrigado pela sua avaliação!"
      });

      const resposta = await processMessage({
        userId: "cliente-7",
        contactName: "Cliente",
        message: "5",
        messageId: "wamid-7"
      });

      expect(resposta).toBe("Muito obrigado pela sua avaliação!");
      expect(mainFlow).not.toHaveBeenCalled();
      expect(ticketService.reopenTicketIfClosed).not.toHaveBeenCalled();
      expect(saveHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "cliente-7", sector: "pesquisa_satisfacao", response: "Muito obrigado pela sua avaliação!" })
      );
    });

    test("sem pesquisa pendente (handleSatisfactionReply retorna null) → continua sem resposta automática de menu/fluxo", async () => {
      const resposta = await processMessage({
        userId: "cliente-8",
        contactName: "Cliente",
        message: "Bom dia",
        messageId: "wamid-8"
      });

      expect(ticketService.handleSatisfactionReply).toHaveBeenCalled();
      expect(mainFlow).not.toHaveBeenCalled();
      expect(resposta).toBe("");
    });
  });

  // BUG CORRIGIDO (relatado pelo usuário, teste ao vivo 2026-07-27): cliente
  // avaliou o atendimento, foi agradecido, e minutos depois mandou só "👍" —
  // o bot reabria o ticket e chamava o fluxo normal como se fosse pergunta
  // nova (nesse caso a IA falhou e devolveu o menu inteiro pro cliente, uma
  // resposta estranha pra uma reação de despedida). Ver
  // pareceEncerramentoPosAvaliacao em ticket.service.js — a decisão de "isso
  // é só um agradecimento" é tomada lá; aqui só testamos que
  // processMessage() respeita esse sinal (não reabre, não chama o bot).
  describe("encerramento pós-avaliação (agradecimento/reação de despedida)", () => {
    test("mensagem reconhecida como encerramento → NÃO reabre ticket, NÃO chama o bot, responde vazio", async () => {
      ticketService.pareceEncerramentoPosAvaliacao.mockResolvedValueOnce(true);

      const resposta = await processMessage({
        userId: "cliente-9",
        contactName: "Cliente",
        message: "👍",
        messageId: "wamid-9"
      });

      expect(ticketService.pareceEncerramentoPosAvaliacao).toHaveBeenCalledWith("cliente-9", "👍");
      expect(ticketService.reopenTicketIfClosed).not.toHaveBeenCalled();
      expect(mainFlow).not.toHaveBeenCalled();
      expect(resposta).toBe("");
      expect(saveHistory).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "cliente-9", sector: "encerramento_pos_avaliacao", response: null })
      );
      expect(emitEvent).toHaveBeenCalledWith(
        "nova_mensagem",
        expect.objectContaining({ userId: "cliente-9", sector: "encerramento_pos_avaliacao" })
      );
    });

    test("não reconhecida como encerramento → segue o fluxo normal (reabre e chama o bot)", async () => {
      ticketService.pareceEncerramentoPosAvaliacao.mockResolvedValueOnce(false);

      const resposta = await processMessage({
        userId: "cliente-10",
        contactName: "Cliente",
        message: "Preciso de outro orçamento",
        messageId: "wamid-10"
      });

      expect(ticketService.reopenTicketIfClosed).toHaveBeenCalledWith("cliente-10");
      expect(mainFlow).toHaveBeenCalled();
      expect(resposta).toBe("resposta normal do bot");
    });

    test("erro ao checar encerramento não derruba o fluxo normal (best-effort)", async () => {
      ticketService.pareceEncerramentoPosAvaliacao.mockRejectedValueOnce(new Error("DB indisponível"));

      const resposta = await processMessage({
        userId: "cliente-11",
        contactName: "Cliente",
        message: "👍",
        messageId: "wamid-11"
      });

      expect(ticketService.reopenTicketIfClosed).toHaveBeenCalledWith("cliente-11");
      expect(mainFlow).toHaveBeenCalled();
      expect(resposta).toBe("resposta normal do bot");
    });
  });
});

describe("processMessage — bot desligado garante ticket pendente", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketService.reopenTicketIfClosed.mockResolvedValue(false);
    ticketService.handleSatisfactionReply.mockResolvedValue(null);
    ticketService.garantirTicketPendente.mockResolvedValue({ criado: true });
    humanMode.estaAtivo.mockReturnValue(false);
    botConfigService.getBotConfig.mockResolvedValue({ ativo: false });
  });

  test("cliente comum com bot desligado → cria ticket pendente e não chama o fluxo do bot", async () => {
    const r = await processMessage({ userId: "5579@s.whatsapp.net", contactName: "João", message: "Preciso de uma peça", messageId: "m1" });
    expect(r).toBe("");
    expect(ticketService.garantirTicketPendente).toHaveBeenCalledWith({ userId: "5579@s.whatsapp.net", customerName: "João", message: "Preciso de uma peça" });
    expect(mainFlow).not.toHaveBeenCalled();
  });

  test("contato com tag Funcionário não gera ticket", async () => {
    await processMessage({ userId: "5579@s.whatsapp.net", contactName: "Equipe", message: "teste", messageId: "m2", isFuncionario: true });
    expect(ticketService.garantirTicketPendente).not.toHaveBeenCalled();
  });

  test("falha ao criar ticket não derruba o processamento", async () => {
    ticketService.garantirTicketPendente.mockRejectedValueOnce(new Error("db fora"));
    const r = await processMessage({ userId: "5579@s.whatsapp.net", contactName: "João", message: "oi", messageId: "m3" });
    expect(r).toBe("");
    expect(saveHistory).toHaveBeenCalled();
  });
});
