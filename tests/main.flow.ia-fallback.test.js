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
jest.mock("../src/services/ai.service", () => ({
  perguntarIA: jest.fn(),
  iaEmFalhaCritica: jest.fn().mockReturnValue(false),
}));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn().mockResolvedValue({ iaAtiva: true }),
}));
jest.mock("../src/flows/vendas.flow", () => {
  const fn = jest.fn().mockResolvedValue(null);
  fn.finalizarOrcamento = jest.fn().mockResolvedValue("ok");
  return fn;
});
const sessionService = require("../src/services/session.service");
const { perguntarIA, iaEmFalhaCritica } = require("../src/services/ai.service");
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
    expect(resposta).toContain("2 - Outros Contatos");
  });

  test("2ª falha seguida: mensagem de dificuldades técnicas, sessão limpa", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins", _iaFalhas: 1 });
    perguntarIA.mockRejectedValue(new Error("timeout"));

    const resposta = await mainFlow({ userId: USER_ID, message: "e motor de partida?" });

    expect(resposta).toContain("dificuldades técnicas");
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
  });

  // PEDIDO DO USUÁRIO (2026-07-27): achado ao vivo — API sem crédito
  // ("credit balance is too low") falha de forma PERMANENTE, não
  // transitória. iaEmFalhaCritica() (ai.service.js) sinaliza esse estado —
  // nesse caso não faz sentido esperar a 2ª falha consecutiva pra escalar
  // pro atendente, já que a 1ª mensagem de "tente novamente" nunca vai
  // resolver sozinha enquanto o crédito não for recarregado.
  test("IA em falha crítica (sem crédito): escala pro atendente JÁ NA 1ª falha, não espera a 2ª", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins", _iaFalhas: 0 });
    perguntarIA.mockResolvedValue(null);
    iaEmFalhaCritica.mockReturnValue(true);

    const resposta = await mainFlow({ userId: USER_ID, message: "e motor de partida?" });

    expect(resposta).toContain("dificuldades técnicas");
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
  });
});
