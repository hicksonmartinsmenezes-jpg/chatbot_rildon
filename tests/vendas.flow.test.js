/**
 * Testes de vendas.flow.js — fluxo de orçamento (nome → veículo → peça).
 *
 * Cobre principalmente o atalho pedido pelo usuário: quando main.flow.js já
 * detectou o veículo na 1ª mensagem (session.veiculoInicial, setado via IA —
 * ver main.flow.js/ai.service.js) e o cliente só precisava informar o nome,
 * o passo "aguardando_nome" agora finaliza o orçamento direto, sem
 * perguntar "qual o veículo?" de novo. O comportamento SEM veiculoInicial
 * (fluxo antigo, pergunta por pergunta) continua coberto como regressão.
 */
jest.mock("../src/services/session.service", () => ({
  updateSession: jest.fn().mockResolvedValue(undefined),
  clearSession: jest.fn().mockResolvedValue(undefined),
  finalizarComTicket: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/ticket.service", () => ({ createTicket: jest.fn() }));
jest.mock("../src/services/notificacao.service", () => ({ notificarAtendente: jest.fn() }));

const sessionService = require("../src/services/session.service");
const { createTicket } = require("../src/services/ticket.service");
const { notificarAtendente } = require("../src/services/notificacao.service");
const MSG = require("../src/flows/messages");
const vendasFlow = require("../src/flows/vendas.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

function fakeTicket(overrides = {}) {
  return {
    id: 1,
    protocolo: "2026-0099",
    customerName: "Hickson Martins",
    description: "Veículo: Fiat Palio 2025 | Produto: motor de partida",
    ...overrides,
  };
}

describe("vendasFlow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("entrada fresca (fora do sector vendas) → entra no sector e mostra o menu", async () => {
    const resposta = await vendasFlow("1", USER_ID, {});
    expect(sessionService.updateSession).toHaveBeenCalledWith(USER_ID, { sector: "vendas" });
    expect(resposta).toContain("Orçamento / Atendimento");
  });

  test("escape ('0') em qualquer etapa limpa a sessão e retorna null", async () => {
    const resposta = await vendasFlow("0", USER_ID, { sector: "vendas", step: "aguardando_veiculo" });
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
    expect(resposta).toBeNull();
  });

  test("aguardando_nome: nome inválido → pede de novo", async () => {
    const resposta = await vendasFlow("x", USER_ID, { sector: "vendas", step: "aguardando_nome" });
    expect(resposta).toContain(MSG.NOME_INVALIDO);
    expect(sessionService.updateSession).not.toHaveBeenCalled();
  });

  test("aguardando_nome SEM veiculoInicial (fluxo antigo) → pergunta o veículo normalmente", async () => {
    const resposta = await vendasFlow("Hickson Martins", USER_ID, { sector: "vendas", step: "aguardando_nome" });

    expect(sessionService.updateSession).toHaveBeenCalledWith(USER_ID, {
      customerName: "Hickson Martins",
      step: "aguardando_veiculo",
    });
    expect(resposta).toContain(MSG.vendas.PEDIR_VEICULO);
    expect(createTicket).not.toHaveBeenCalled();
  });

  // Pedido do usuário: "motor de partida fiat palio 2025" — não deveria
  // perguntar o veículo de novo já que veio tudo na 1ª mensagem.
  test("aguardando_nome COM veiculoInicial → finaliza o orçamento direto, sem perguntar veículo", async () => {
    createTicket.mockResolvedValue(fakeTicket());

    const resposta = await vendasFlow("Hickson Martins", USER_ID, {
      sector: "vendas",
      step: "aguardando_nome",
      produtoInicial: "motor de partida fiat palio 2025",
      veiculoInicial: "Fiat Palio 2025",
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "orcamento",
        customerName: "Hickson Martins",
        description: "Veículo: Fiat Palio 2025 | Produto: motor de partida fiat palio 2025",
      })
    );
    expect(sessionService.finalizarComTicket).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ protocolo: "2026-0099" }));
    expect(notificarAtendente).toHaveBeenCalled();
    expect(resposta).toContain("Orçamento registrado");
    expect(resposta).toContain("2026-0099");
    expect(resposta).not.toContain(MSG.vendas.PEDIR_VEICULO);
    expect(resposta).not.toContain("Qual o *veículo*");
  });

  test("aguardando_nome COM veiculoInicial, mas criação do ticket falha → mensagem de falha (best-effort, não trava o cliente)", async () => {
    createTicket.mockResolvedValue(null);

    const resposta = await vendasFlow("Hickson Martins", USER_ID, {
      sector: "vendas",
      step: "aguardando_nome",
      produtoInicial: "motor de partida fiat palio 2025",
      veiculoInicial: "Fiat Palio 2025",
    });

    expect(resposta).toContain("Não consegui registrar sua solicitação");
    expect(notificarAtendente).not.toHaveBeenCalled();
  });

  test("aguardando_veiculo: produtoInicial já descritivo (comportamento antigo) finaliza sem pedir peça separada", async () => {
    createTicket.mockResolvedValue(fakeTicket({ description: "Veículo: Gol 2018 | Produto: alternador" }));

    const resposta = await vendasFlow("Gol 2018", USER_ID, {
      sector: "vendas",
      step: "aguardando_veiculo",
      produtoInicial: "alternador",
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Veículo: Gol 2018 | Produto: alternador" })
    );
    expect(resposta).toContain("Orçamento registrado");
  });

  test("aguardando_veiculo: produtoInicial curto demais → pergunta a peça separadamente (comportamento antigo)", async () => {
    const resposta = await vendasFlow("Gol 2018", USER_ID, {
      sector: "vendas",
      step: "aguardando_veiculo",
      produtoInicial: "",
    });

    expect(resposta).toContain(MSG.vendas.PEDIR_ORCAMENTO);
    expect(createTicket).not.toHaveBeenCalled();
  });

  test("aguardando_orcamento: finaliza com o veículo já coletado antes", async () => {
    createTicket.mockResolvedValue(fakeTicket({ description: "Veículo: Uno 2010 | Produto: farol completo" }));

    const resposta = await vendasFlow("farol completo", USER_ID, {
      sector: "vendas",
      step: "aguardando_orcamento",
      veiculo: "Uno 2010",
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Veículo: Uno 2010 | Produto: farol completo" })
    );
    expect(resposta).toContain("Orçamento registrado");
  });

  test("finalizarOrcamento é exportado e utilizável diretamente (contrato usado por main.flow.js)", async () => {
    expect(typeof vendasFlow.finalizarOrcamento).toBe("function");

    createTicket.mockResolvedValue(fakeTicket());
    const resposta = await vendasFlow.finalizarOrcamento(
      USER_ID,
      { customerName: "Hickson Martins" },
      "Fiat Palio 2025",
      "motor de partida fiat palio 2025"
    );

    expect(resposta).toContain("Orçamento registrado");
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ customerName: "Hickson Martins" })
    );
  });

  // Pedido do usuário: descrição do ticket não deve repetir a frase
  // inteira do cliente (com saudação) quando a IA já isolou o nome limpo
  // da peça (pecaInicial, setado em main.flow.js).
  test("aguardando_nome COM veiculoInicial E pecaInicial → usa a peça limpa na descrição, não produtoInicial", async () => {
    createTicket.mockResolvedValue(fakeTicket());

    await vendasFlow("Hickson Martins", USER_ID, {
      sector: "vendas",
      step: "aguardando_nome",
      produtoInicial: "Bom dia, motor de partida fiat uno 2025",
      veiculoInicial: "Fiat Uno 2025",
      pecaInicial: "Motor de partida",
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Veículo: Fiat Uno 2025 | Produto: Motor de partida",
      })
    );
  });

  test("aguardando_nome COM veiculoInicial mas SEM pecaInicial → cai de volta pro produtoInicial (compatibilidade)", async () => {
    createTicket.mockResolvedValue(fakeTicket());

    await vendasFlow("Hickson Martins", USER_ID, {
      sector: "vendas",
      step: "aguardando_nome",
      produtoInicial: "motor de partida fiat uno 2025",
      veiculoInicial: "Fiat Uno 2025",
      // sem pecaInicial
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Veículo: Fiat Uno 2025 | Produto: motor de partida fiat uno 2025",
      })
    );
  });

  test("aguardando_veiculo: pecaInicial (se presente) é preferido a produtoInicial na descrição", async () => {
    createTicket.mockResolvedValue(fakeTicket());

    await vendasFlow("Gol 2018", USER_ID, {
      sector: "vendas",
      step: "aguardando_veiculo",
      produtoInicial: "Bom dia, preciso de um alternador pro meu gol 2018",
      pecaInicial: "Alternador",
    });

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Veículo: Gol 2018 | Produto: Alternador",
      })
    );
  });
});
