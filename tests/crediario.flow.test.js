/**
 * Testes de crediario.flow.js — cobre principalmente a detecção de mudança
 * de assunto nas etapas de texto livre (nome/motivo), espelhando a mesma
 * correção aplicada em vendas.flow.js (ver tests/vendas.flow.test.js). Bug
 * real: cliente pergunta sobre outro setor (ex: orçamento de peça) durante a
 * coleta de nome/motivo do crediário, e a pergunta vira literalmente o dado
 * salvo, sem nunca ser respondida.
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
const crediarioFlow = require("../src/flows/crediario.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

function fakeTicket(overrides = {}) {
  return {
    id: 1,
    protocolo: "2026-0100",
    customerName: "Hickson Martins",
    description: "Solicitação de crediário",
    ...overrides,
  };
}

describe("crediarioFlow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("entrada fresca (fora do sector crediario) → entra no sector e mostra o menu", async () => {
    const resposta = await crediarioFlow("2", USER_ID, {});
    expect(sessionService.updateSession).toHaveBeenCalledWith(USER_ID, { sector: "crediario" });
    expect(resposta).toContain("Crediário");
  });

  test("escape ('0') em qualquer etapa limpa a sessão e retorna null", async () => {
    const resposta = await crediarioFlow("0", USER_ID, { sector: "crediario", step: "aguardando_motivo_cred" });
    expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
    expect(resposta).toBeNull();
  });

  test("aguardando_nome_cred: nome válido avança para CPF", async () => {
    const resposta = await crediarioFlow("Hickson Martins", USER_ID, { sector: "crediario", step: "aguardando_nome_cred" });
    expect(sessionService.updateSession).toHaveBeenCalledWith(USER_ID, {
      customerName: "Hickson Martins",
      step: "aguardando_cpf",
    });
    expect(resposta).toContain(MSG.crediario.PEDIR_CPF);
  });

  test("aguardando_cpf: CPF inválido pede de novo (não é tratado como mudança de assunto)", async () => {
    const resposta = await crediarioFlow("123", USER_ID, { sector: "crediario", step: "aguardando_cpf" });
    expect(resposta).toContain(MSG.CPF_INVALIDO);
    expect(createTicket).not.toHaveBeenCalled();
  });

  test("aguardando_motivo_cred: motivo válido cria o ticket normalmente", async () => {
    createTicket.mockResolvedValue(fakeTicket());
    const resposta = await crediarioFlow(
      "quero abrir crediário pra comprar peças no final do mês",
      USER_ID,
      { sector: "crediario", step: "aguardando_motivo_cred", customerName: "Hickson Martins" }
    );
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ type: "crediario", customerName: "Hickson Martins" })
    );
    expect(notificarAtendente).toHaveBeenCalled();
    expect(resposta).toContain("2026-0100");
  });

  // BUG (mesmo padrão do vendas.flow.js): cliente pergunta sobre outro
  // setor durante a coleta de nome/motivo do crediário.
  describe("detecção de mudança de assunto (cliente pergunta sobre outro setor)", () => {
    test("aguardando_motivo_cred: pergunta sobre horário de funcionamento sai do fluxo em vez de virar o motivo", async () => {
      const resposta = await crediarioFlow(
        "na verdade, que horas fecha?",
        USER_ID,
        { sector: "crediario", step: "aguardando_motivo_cred", customerName: "Hickson Martins" }
      );

      expect(createTicket).not.toHaveBeenCalled();
      expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
      expect(resposta).toContain("outro assunto");
    });

    test("aguardando_nome_cred: pergunta sobre horário de funcionamento também é detectada", async () => {
      const resposta = await crediarioFlow(
        "voces abrem que horario de funcionamento?",
        USER_ID,
        { sector: "crediario", step: "aguardando_nome_cred" }
      );

      expect(sessionService.clearSession).toHaveBeenCalledWith(USER_ID);
      expect(resposta).toContain("outro assunto");
    });

    test("aguardando_cpf: pergunta fora de contexto NÃO usa detecção de mudança de assunto — cai no fluxo de CPF inválido", async () => {
      const resposta = await crediarioFlow(
        "que horas fecha?",
        USER_ID,
        { sector: "crediario", step: "aguardando_cpf" }
      );

      expect(sessionService.clearSession).not.toHaveBeenCalled();
      expect(resposta).toContain(MSG.CPF_INVALIDO);
      expect(resposta).not.toContain("outro assunto");
    });

    test("motivo legítimo mencionando peça/crediário continua sendo aceito normalmente (evita falso positivo)", async () => {
      createTicket.mockResolvedValue(fakeTicket({ description: "Quero financiar peças pro meu carro" }));

      const resposta = await crediarioFlow(
        "quero financiar peças pro meu carro, tem crediario?",
        USER_ID,
        { sector: "crediario", step: "aguardando_motivo_cred", customerName: "Hickson Martins" }
      );

      expect(createTicket).toHaveBeenCalled();
      expect(resposta).toContain("2026-0100");
    });
  });
});
