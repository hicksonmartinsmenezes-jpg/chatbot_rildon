/**
 * Testes de vendas.flow.js — etapa "aguardando_veiculo" e o fallback de
 * peça já informada (session.pecaInicial / session.produtoInicial).
 *
 * BUG REAL (achado em teste ao vivo, 2026-07-20): o cliente pergunta
 * "vocês trabalham com bomba de combustível?", a IA responde e o bot pede
 * confirmação de orçamento (fluxo de main.flow.js). Ao confirmar com "sim"
 * SEM ainda ter dito o veículo, main.flow.js manda o cliente pro
 * vendas.flow.js já com session.pecaInicial="bomba de combustível" — mas
 * NÃO seta session.produtoInicial (só o caminho de pedidoExplicito direto
 * seta os dois). O check em vendas.flow.js (etapa aguardando_veiculo) só
 * olhava pra produtoInicial pra decidir se pula a pergunta "qual peça você
 * precisa?" — resultado: o cliente informa o veículo e é perguntado de novo
 * a peça que ele JÁ tinha dito, uma repetição irritante e evitável.
 */
jest.mock("../src/services/session.service", () => ({
  updateSession: jest.fn().mockResolvedValue(undefined),
  clearSession: jest.fn().mockResolvedValue(undefined),
  finalizarComTicket: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/ticket.service", () => ({
  createTicket: jest.fn().mockResolvedValue({
    id: 1,
    protocolo: "2026-0099",
    customerName: "Hickson Martins",
    description: "",
  }),
}));
jest.mock("../src/services/notificacao.service", () => ({ notificarAtendente: jest.fn() }));

const ticketService = require("../src/services/ticket.service");
const vendasFlow = require("../src/flows/vendas.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("vendasFlow — etapa aguardando_veiculo com peça já informada antes da confirmação", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ticketService.createTicket.mockResolvedValue({
      id: 1,
      protocolo: "2026-0099",
      customerName: "Design / Marketing",
      description: "",
    });
  });

  test("só pecaInicial setado (sem produtoInicial) → finaliza direto, sem perguntar peça de novo", async () => {
    const session = {
      sector: "vendas",
      step: "aguardando_veiculo",
      customerName: "Design / Marketing",
      pecaInicial: "bomba de combustível",
      // produtoInicial ausente — é exatamente o caminho da confirmação de
      // orçamento em main.flow.js, que só grava pecaInicial.
    };

    const resposta = await vendasFlow("Fiat Uno 2015", USER_ID, session);

    expect(resposta).not.toContain("Qual");
    expect(resposta).not.toContain("peça");
    expect(ticketService.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("bomba de combustível"),
      })
    );
  });

  test("produtoInicial setado (caminho de pedidoExplicito direto) continua funcionando como antes", async () => {
    const session = {
      sector: "vendas",
      step: "aguardando_veiculo",
      customerName: "Hickson Martins",
      produtoInicial: "quero um motor de partida pro meu carro",
      pecaInicial: "Motor de partida",
    };

    const resposta = await vendasFlow("Fiat Palio 2020", USER_ID, session);

    // Prefere pecaInicial (nome limpo) à frase crua de produtoInicial
    expect(ticketService.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Motor de partida"),
      })
    );
    expect(resposta).not.toContain("Qual *peça*");
  });

  test("nem pecaInicial nem produtoInicial → continua perguntando a peça normalmente (comportamento inalterado)", async () => {
    const session = {
      sector: "vendas",
      step: "aguardando_veiculo",
      customerName: "Hickson Martins",
    };

    const resposta = await vendasFlow("Fiat Uno 2015", USER_ID, session);

    expect(resposta).toContain("peça");
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });

  test("pecaInicial muito curto (< 5 chars após normalizar) não passa no check de validade → ainda pergunta a peça", async () => {
    const session = {
      sector: "vendas",
      step: "aguardando_veiculo",
      customerName: "Hickson Martins",
      pecaInicial: "abc",
    };

    const resposta = await vendasFlow("Fiat Uno 2015", USER_ID, session);

    expect(resposta).toContain("peça");
    expect(ticketService.createTicket).not.toHaveBeenCalled();
  });
});
