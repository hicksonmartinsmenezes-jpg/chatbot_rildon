/**
 * Testes do intercept de confirmação de orçamento ("sim"/"1") em main.flow.js.
 *
 * BUG REAL (relatado pelo usuário, testes de edge-case — reproduzido 2x:
 * "radiador" e "pneu", ambos claramente ditos pelo cliente): quando a IA
 * falha em preencher o campo estruturado "peca" (session.pecaSugerido fica
 * null), a confirmação de orçamento caía direto no fallback genérico
 * "Consulta de peça" — perdendo a peça real que o cliente tinha digitado.
 * Corrigido guardando a mensagem crua (session.produtoSugerido) no momento
 * em que a pergunta de confirmação é exibida, e usando-a como fallback
 * intermediário antes do texto genérico.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/services/session.service", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn().mockResolvedValue(undefined),
  clearSession: jest.fn().mockResolvedValue(undefined),
  finalizarComTicket: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/ticket.service", () => ({ createTicket: jest.fn() }));
jest.mock("../src/services/notificacao.service", () => ({
  notificarAtendente: jest.fn(),
  notificarSeDisponivel: jest.fn(),
}));
jest.mock("../src/services/ai.service", () => ({ perguntarIA: jest.fn(), iaEmFalhaCritica: jest.fn().mockReturnValue(false) }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn().mockResolvedValue({ iaAtiva: true }),
}));
jest.mock("../src/flows/vendas.flow", () => {
  const fn = jest.fn().mockResolvedValue(null);
  fn.finalizarOrcamento = jest.fn().mockResolvedValue("confirmado");
  return fn;
});
const sessionService = require("../src/services/session.service");
const vendasFlow = require("../src/flows/vendas.flow");
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("mainFlow — confirmação de orçamento ('sim'/'1') com pecaSugerido ausente", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("pecaSugerido null, mas produtoSugerido presente → usa produtoSugerido em vez do texto genérico", async () => {
    sessionService.getSession.mockReturnValue({
      sector: "main",
      customerName: "Hickson Martins",
      aguardandoConfirmacaoOrcamento: true,
      veiculoSugerido: "Fiat Uno 2015",
      pecaSugerido: null,
      produtoSugerido: "radiador",
    });

    await mainFlow({ userId: USER_ID, message: "sim" });

    expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
      USER_ID,
      { customerName: "Hickson Martins" },
      "Fiat Uno 2015",
      "radiador"
    );
  });

  test("pecaSugerido E produtoSugerido ausentes → cai no texto genérico (failsafe final)", async () => {
    sessionService.getSession.mockReturnValue({
      sector: "main",
      customerName: "Hickson Martins",
      aguardandoConfirmacaoOrcamento: true,
      veiculoSugerido: "Fiat Uno 2015",
      pecaSugerido: null,
      produtoSugerido: null,
    });

    await mainFlow({ userId: USER_ID, message: "sim" });

    expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
      USER_ID,
      { customerName: "Hickson Martins" },
      "Fiat Uno 2015",
      "Consulta de peça"
    );
  });

  test("pecaSugerido presente → é preferido a produtoSugerido (campo estruturado tem prioridade)", async () => {
    sessionService.getSession.mockReturnValue({
      sector: "main",
      customerName: "Hickson Martins",
      aguardandoConfirmacaoOrcamento: true,
      veiculoSugerido: "Fiat Uno 2015",
      pecaSugerido: "Radiador",
      produtoSugerido: "tem radiador pra fiat uno 2015?",
    });

    await mainFlow({ userId: USER_ID, message: "1" });

    expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
      USER_ID,
      { customerName: "Hickson Martins" },
      "Fiat Uno 2015",
      "Radiador"
    );
  });

  // BUG REAL (achado em sessão de testes de personas, 2026-07-17): o
  // intercept só reconhecia "sim"/"1" com match EXATO — msgNorm remove
  // acento/caixa mas não pontuação, então "Sim!", "sim." ou "Sim!!"
  // (pontuação/ênfase natural de quem está confirmando de verdade) caíam
  // no fallback "não confirma agora", abandonando o orçamento em silêncio.
  test.each(["Sim!", "sim.", "SIM!!", "1."])(
    "confirma o orçamento mesmo com pontuação: %s",
    async (mensagem) => {
      sessionService.getSession.mockReturnValue({
        sector: "main",
        customerName: "Hickson Martins",
        aguardandoConfirmacaoOrcamento: true,
        veiculoSugerido: "Fiat Uno 2015",
        pecaSugerido: "Radiador",
        produtoSugerido: "radiador",
      });

      await mainFlow({ userId: USER_ID, message: mensagem });

      expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
        USER_ID,
        { customerName: "Hickson Martins" },
        "Fiat Uno 2015",
        "Radiador"
      );
    }
  );

  test("mensagem que não é 'sim'/'1' (com ou sem pontuação) NÃO confirma — segue processamento normal", async () => {
    const { perguntarIA } = require("../src/services/ai.service");
    sessionService.getSession.mockReturnValue({
      sector: "main",
      customerName: "Hickson Martins",
      aguardandoConfirmacaoOrcamento: true,
      veiculoSugerido: "Fiat Uno 2015",
      pecaSugerido: "Radiador",
      produtoSugerido: "radiador",
      _iaFalhas: 0,
    });
    perguntarIA.mockResolvedValue({ resposta: "Olá! Como posso ajudar?", intencao: "chat" });

    await mainFlow({ userId: USER_ID, message: "não, deixa pra depois" });

    expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    // A flag deve ser limpa (não reaproveita confirmação antiga numa consulta futura)
    expect(sessionService.updateSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ aguardandoConfirmacaoOrcamento: undefined })
    );
  });

  test("resposta de disponibilidade sem pergunta explícita salva produtoSugerido na sessão", async () => {
    const { perguntarIA } = require("../src/services/ai.service");
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins", _iaFalhas: 0 });
    perguntarIA.mockResolvedValue({
      resposta: "Trabalhamos com peças pra Fiat em geral. 😊",
      intencao: "vendas",
      veiculo: null,
      peca: null,
      pedidoExplicito: false,
    });

    await mainFlow({ userId: USER_ID, message: "tem radiador pra fiat uno 2015?" });

    expect(sessionService.updateSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ produtoSugerido: "tem radiador pra fiat uno 2015?" })
    );
  });
});
