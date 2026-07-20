/**
 * Testes de main.flow.js — detecção de mudança de assunto no fluxo de gestão
 * ("Falar com a Equipe").
 *
 * BUG REAL (achado em teste ao vivo, 2026-07-20): esse fluxo pede nome e
 * motivo em 2 mensagens. Na etapa "informe seu nome", validarNome só checa
 * se o texto parece palavras de nome (letras, ≥2 palavras) — não o sentido.
 * Reproduzido ao vivo: cliente enviou "na verdade vocês fazem crediário?" na
 * etapa de nome, e a pergunta real foi engolida como se fosse o nome — nunca
 * foi respondida, e o ticket criado depois nem menciona crediário. Corrigido
 * com o mesmo padrão de _pareceMudancaDeAssunto já usado em vendas.flow.js e
 * crediario.flow.js, mas restrito a "crediário" (setor claramente distinto)
 * e só na etapa de nome — na etapa de MOTIVO, mencionar crediário pode ser a
 * reclamação legítima do cliente, não uma mudança de assunto.
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
jest.mock("../src/flows/vendas.flow", () => jest.fn().mockResolvedValue(null));
jest.mock("../src/flows/crediario.flow", () => jest.fn().mockResolvedValue(null));

const sessionService = require("../src/services/session.service");
const ticketService = require("../src/services/ticket.service");
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("mainFlow — mudança de assunto no fluxo de gestão (etapa nome)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("pergunta sobre crediário na etapa 'informe seu nome' não vira nome do ticket", async () => {
    sessionService.getSession.mockReturnValue({ sector: "gestao", step: "aguardando_nome" });

    const resposta = await mainFlow({
      userId: USER_ID,
      message: "na verdade voces fazem crediario?",
    });

    expect(resposta).toContain("crediário");
    expect(resposta).toContain("*2 - Crediário*");
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
    expect(ticketService.createTicket).not.toHaveBeenCalled();
    // Não deve ter avançado pra etapa de motivo com esse texto como nome
    expect(sessionService.updateSession).not.toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ customerName: expect.stringContaining("crediario") })
    );
  });

  test("variação 'financiamento' também é detectada como mudança de assunto", async () => {
    sessionService.getSession.mockReturnValue({ sector: "gestao", step: "aguardando_nome" });

    const resposta = await mainFlow({ userId: USER_ID, message: "voces tem financiamento?" });

    expect(resposta).toContain("crediário");
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
  });

  test("nome real de cliente continua funcionando normalmente (sem falso positivo)", async () => {
    sessionService.getSession.mockReturnValue({ sector: "gestao", step: "aguardando_nome" });

    const resposta = await mainFlow({ userId: USER_ID, message: "Hickson Martins" });

    expect(sessionService.updateSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ customerName: "Hickson Martins", step: "aguardando_motivo_gestao" })
    );
    expect(resposta).not.toContain("crediário");
  });

  test("na etapa de MOTIVO, mencionar crediário é aceito normalmente (reclamação legítima, não mudança de assunto)", async () => {
    sessionService.getSession.mockReturnValue({
      sector: "gestao",
      step: "aguardando_motivo_gestao",
      customerName: "Hickson Martins",
    });
    ticketService.createTicket.mockResolvedValue({
      id: 1,
      protocolo: "2026-0099",
      customerName: "Hickson Martins",
    });

    const resposta = await mainFlow({
      userId: USER_ID,
      message: "meu crediario nao foi aprovado e ninguem me explicou por que",
    });

    expect(ticketService.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("crediario"),
      })
    );
    expect(resposta).toContain("registrada com sucesso");
  });
});
