/**
 * Testes do switch de opções do menu principal em main.flow.js.
 *
 * BUG REAL (achado em nova sessão de testes de personas, 2026-07-20): cliente
 * digita a opção do menu com pontuação/ênfase natural ("1.", "2)", "3!") —
 * msgNorm só remove acento/caixa, não pontuação, então "1." !== "1" e a
 * mensagem caía no fallback de IA em vez de rotear pro menu certo (mesma
 * classe de bug já corrigida antes no intercept de confirmação de orçamento
 * — ver main.flow.confirmacao-orcamento.test.js). Corrigido computando
 * msgMenu = msgSemPontuacao quando ela isolada é um dígito válido do menu
 * (1-3, após a remoção do Crediário em 2026-07-24 — era 1-4 antes disso),
 * senão mantém msgNorm.
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
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("mainFlow — opções do menu principal com pontuação", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionService.getSession.mockReturnValue({ sector: "main" });
  });

  test.each(["1", "1.", "1!", "1)"])(
    "'%s' → entra no formulário de orçamento (pede nome)",
    async (mensagem) => {
      const resposta = await mainFlow({ userId: USER_ID, message: mensagem });
      expect(resposta).toContain("nome completo");
      expect(sessionService.updateSession).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ sector: "vendas", step: "aguardando_nome" })
      );
    }
  );

  // Opção 2 (renumerada de 3 após a remoção do Crediário, 2026-07-24) —
  // mensagem estática, sem sector/step (ver messages.js MSG.outrosContatos).
  // ATUALIZADO (2026-08-14): "sem entrar em fluxo/sessão" continua valendo
  // pra sector/step — mas agora TODA mensagem passa pelo contador
  // contadorMsgsBot do limite de 3 mensagens (ver mainFlow, wrapper em
  // main.flow.js), então updateSession passa a ser chamado aqui também,
  // só que SEM sector/step — mantém o invariante original (esta opção não
  // inicia fluxo nenhum), só não é mais 100% stateless.
  test.each(["2", "2.", "2)"])(
    "'%s' → mostra a lista de Outros Contatos, sem entrar em fluxo/sessão (só conta a mensagem)",
    async (mensagem) => {
      const resposta = await mainFlow({ userId: USER_ID, message: mensagem });
      expect(resposta).toContain("Outros Contatos");
      expect(resposta).toContain("Ouvidoria");
      expect(sessionService.updateSession).toHaveBeenCalledTimes(1);
      expect(sessionService.updateSession).toHaveBeenCalledWith(USER_ID, { contadorMsgsBot: 1 });
    }
  );

  // Opção 3 (renumerada de 4)
  test("'3!' → mostra horário de atendimento", async () => {
    const resposta = await mainFlow({ userId: USER_ID, message: "3!" });
    expect(resposta).toContain("Horário de Atendimento");
  });

  test("mensagem de texto livre que só CONTÉM um dígito válido não é tratada como opção de menu (ex: 'tenho 1 carro')", async () => {
    const { perguntarIA } = require("../src/services/ai.service");
    perguntarIA.mockResolvedValue({ resposta: "Entendi!", intencao: "chat" });

    const resposta = await mainFlow({ userId: USER_ID, message: "tenho 1 carro" });

    // Não deve ter entrado no form de orçamento (isso só aconteceria se
    // msgSemPontuacao === "1", que exige que a mensagem INTEIRA vire "1"
    // após remover pontuação — "tenho 1 carro" vira "tenho 1 carro", não "1").
    expect(resposta).not.toContain("nome completo");
    expect(perguntarIA).toHaveBeenCalled();
  });
});
