/**
 * Testes do limite de 3 mensagens do bot por atendimento em main.flow.js.
 *
 * PEDIDO DO USUÁRIO (2026-08-14): "preciso que o bot atenda até 3 mensagens
 * de clientes e encaminhe direto pra o atendente". Escolhas confirmadas via
 * AskUserQuestion: a 3ª mensagem AINDA é respondida normalmente pelo bot —
 * só depois disso é que avisa e transfere; o contador reseta por ticket/
 * atendimento (finalizarComTicket zera contadorMsgsBot — ver
 * session.service.js); vale pra qualquer intenção, não só vendas.
 *
 * Usa um "sessionStore" simples (objeto mutável) por trás dos mocks de
 * session.service pra simular o merge real de updateSession/getSession ao
 * longo de várias chamadas seguidas de mainFlow — sem isso não dá pra
 * testar um contador que precisa persistir entre mensagens.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/services/session.service", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn(),
  clearSession: jest.fn(),
  finalizarComTicket: jest.fn(),
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
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    atendimento: { mensagemTransferencia: "Vou te transferir pra um atendente humano." },
  }),
}));
jest.mock("../src/flows/vendas.flow", () => {
  const fn = jest.fn().mockResolvedValue(null);
  fn.finalizarOrcamento = jest.fn().mockResolvedValue("ok");
  return fn;
});

const sessionService = require("../src/services/session.service");
const { createTicket } = require("../src/services/ticket.service");
const { notificarAtendente } = require("../src/services/notificacao.service");
const { perguntarIA } = require("../src/services/ai.service");
const vendasFlow = require("../src/flows/vendas.flow");
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("mainFlow — limite de 3 mensagens do bot por atendimento", () => {
  let sessao;

  beforeEach(() => {
    jest.clearAllMocks();
    sessao = { sector: "main" };

    sessionService.getSession.mockImplementation(() => sessao);
    sessionService.updateSession.mockImplementation(async (userId, data) => {
      sessao = { ...sessao, ...data };
    });
    sessionService.clearSession.mockImplementation(async () => {
      sessao = { sector: "main" };
    });
    sessionService.finalizarComTicket.mockImplementation(async () => {
      // Mesmo reset que a implementação real faz (ver session.service.js).
      sessao = { ...sessao, sector: undefined, step: undefined, contadorMsgsBot: 0 };
    });

    createTicket.mockResolvedValue({ protocolo: "2026-0999", id: 1 });
    perguntarIA.mockResolvedValue({
      resposta: "Sim, trabalhamos com essa peça!",
      intencao: "chat",
      veiculo: null,
      peca: null,
      pedidoExplicito: false,
    });
  });

  test("1ª e 2ª mensagem: bot responde normal, sem transferir", async () => {
    const r1 = await mainFlow({ userId: USER_ID, message: "bom dia, tem alternador?" });
    expect(r1).not.toContain("Vou te transferir");
    expect(createTicket).not.toHaveBeenCalled();

    const r2 = await mainFlow({ userId: USER_ID, message: "e pra qual carro?" });
    expect(r2).not.toContain("Vou te transferir");
    expect(createTicket).not.toHaveBeenCalled();
  });

  test("3ª mensagem: responde normalmente E já transfere pro atendente (mesma resposta)", async () => {
    await mainFlow({ userId: USER_ID, message: "msg 1" });
    await mainFlow({ userId: USER_ID, message: "msg 2" });
    const r3 = await mainFlow({ userId: USER_ID, message: "msg 3" });

    expect(r3).toContain("Sim, trabalhamos com essa peça!");
    expect(r3).toContain("Vou te transferir pra um atendente humano.");
    expect(r3).toContain("2026-0999");

    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, type: "atendente_humano" })
    );
    expect(notificarAtendente).toHaveBeenCalledTimes(1);
  });

  test("depois de transferir, o contador reseta — 4ª mensagem não transfere de novo", async () => {
    await mainFlow({ userId: USER_ID, message: "msg 1" });
    await mainFlow({ userId: USER_ID, message: "msg 2" });
    await mainFlow({ userId: USER_ID, message: "msg 3" }); // transfere e zera o contador

    createTicket.mockClear();
    notificarAtendente.mockClear();

    const r4 = await mainFlow({ userId: USER_ID, message: "msg 4" });
    expect(r4).not.toContain("Vou te transferir");
    expect(createTicket).not.toHaveBeenCalled();
  });

  test("não duplica transferência quando o próprio fluxo já criou ticket nesta mesma mensagem", async () => {
    await mainFlow({ userId: USER_ID, message: "msg 1" });
    await mainFlow({ userId: USER_ID, message: "msg 2" });

    // Força a sessão pro estado "dentro do fluxo de vendas, aguardando dígito"
    sessao = { ...sessao, sector: "vendas", step: "aguardando_orcamento" };

    // Simula o sub-fluxo de vendas fechando o orçamento e criando o ticket
    // internamente nesta mesma mensagem (chama finalizarComTicket, que já
    // zera contadorMsgsBot — ver mock acima).
    vendasFlow.mockImplementationOnce(async (message, userId) => {
      await sessionService.finalizarComTicket(userId, { protocolo: "V-1" });
      return "Orçamento confirmado! Protocolo V-1";
    });

    const r3 = await mainFlow({ userId: USER_ID, message: "1" });

    expect(r3).toBe("Orçamento confirmado! Protocolo V-1");
    expect(r3).not.toContain("Vou te transferir");
    // _criarTicket (createTicket real do main.flow) não foi chamado — só o
    // finalizarComTicket direto simulado pelo mock do vendasFlow acima.
    expect(createTicket).not.toHaveBeenCalled();
  });
});
