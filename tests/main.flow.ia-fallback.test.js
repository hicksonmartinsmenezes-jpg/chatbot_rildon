/**
 * Testes do fallback de falha de IA em main.flow.js.
 *
 * BUG CORRIGIDO (relatado pelo usuário durante teste ao vivo): quando a IA
 * falha UMA vez no meio de uma conversa já em andamento, o fallback usava
 * menuPrincipal() — que inclui a saudação inteira de novo ("Bom dia,
 * Fulano! Seja bem-vindo de volta..."), como se a conversa tivesse
 * reiniciado do zero. Trocado para menuCompacto() (só as opções, sem
 * saudação), consistente com o mesmo fallback já usado pra intenção
 * "chat"/não reconhecida.
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
jest.mock("../src/services/ai.service", () => ({ perguntarIA: jest.fn() }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn().mockResolvedValue({ iaAtiva: true }),
}));
jest.mock("../src/flows/vendas.flow", () => {
  const fn = jest.fn().mockResolvedValue(null);
  fn.finalizarOrcamento = jest.fn().mockResolvedValue("ok");
  return fn;
});
jest.mock("../src/flows/crediario.flow", () => jest.fn().mockResolvedValue(null));

const sessionService = require("../src/services/session.service");
const { perguntarIA } = require("../src/services/ai.service");
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("mainFlow — fallback quando perguntarIA falha", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1ª falha: mostra menu COMPACTO (sem saudação), não o menu principal completo", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins", _iaFalhas: 0 });
    perguntarIA.mockRejectedValue(new Error("timeout"));

    const resposta = await mainFlow({ userId: USER_ID, message: "e motor de partida?" });

    expect(resposta).toContain("Não consegui processar sua mensagem agora");
    // Não deve repetir a saudação como se a conversa tivesse reiniciado
    expect(resposta).not.toContain("Bem-vindo");
    expect(resposta).not.toContain("Hickson");
    // Mas ainda mostra as opções do menu
    expect(resposta).toContain("1 - Orçamento");
    expect(resposta).toContain("2 - Crediário");
  });

  test("2ª falha seguida: mensagem de dificuldades técnicas, sessão limpa", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins", _iaFalhas: 1 });
    perguntarIA.mockRejectedValue(new Error("timeout"));

    const resposta = await mainFlow({ userId: USER_ID, message: "e motor de partida?" });

    expect(resposta).toContain("dificuldades técnicas");
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
  });
});
