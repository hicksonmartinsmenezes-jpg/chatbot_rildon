/**
 * Testes de session.service.js — foco no bug relatado pelo usuário:
 *
 * Depois que um ticket é criado (orçamento/crediário/etc via
 * finalizarComTicket), o cliente recebia "⏳ Ainda está aí?" e depois
 * "👋 Atendimento encerrado por inatividade." — mesmo o bot já tendo
 * concluído o atendimento ("consultor entrará em contato"). Causa: TODO
 * updateSession() reagendava os timers de aviso/encerramento
 * incondicionalmente, inclusive dentro de finalizarComTicket().
 *
 * Fix: updateSession() agora aceita { skipTimer: true }, usado só por
 * finalizarComTicket() — cancela qualquer timer pendente sem agendar um
 * novo. A sessão continua existindo (aiHistorico preservado pra perguntas
 * de acompanhamento), só não dispara mais os avisos de inatividade depois
 * que o pedido já foi registrado.
 *
 * Usa timers REAIS (não jest.useFakeTimers) com timeouts pequenos (via mock
 * de botConfig.service), pra evitar a complexidade de ter que flushar
 * manualmente a cadeia de promises dentro de resetTimer() (que chama
 * getTimeouts() de forma "fire-and-forget", sem await).
 */
jest.mock("../src/database/postgres", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] })
}));

// timeoutAviso/timeoutEncerramento em "minutos" — usamos frações pequenas
// pra virar poucos milissegundos reais (* 60_000 dentro de getTimeouts()).
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn().mockResolvedValue({
    timeoutAviso: 0.005,      // 300ms
    timeoutEncerramento: 0.01 // 600ms
  })
}));

const sessionService = require("../src/services/session.service");

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("session.service — timers de inatividade x finalizarComTicket", () => {
  let sendMessage;

  beforeEach(async () => {
    sendMessage = jest.fn().mockResolvedValue(undefined);
    await sessionService.setSendMessage(sendMessage);
  });

  test("updateSession comum (fluxo em andamento) ainda agenda os avisos normalmente", async () => {
    await sessionService.updateSession("user-fluxo-normal", {
      sector: "vendas",
      step: "aguardando_veiculo"
    });

    // Espera passar do aviso (300ms) E do encerramento (600ms) — deixa o
    // timer desse usuário se auto-limpar (clearSession no fim do
    // encerramento) antes do próximo teste rodar, evitando que ele dispare
    // "atrasado" durante outro teste (timer é um setTimeout real do Node,
    // não é resetado automaticamente entre testes).
    await esperar(700);

    expect(sendMessage).toHaveBeenCalledWith(
      "user-fluxo-normal",
      expect.stringContaining("Ainda está aí")
    );
  }, 10000);

  test("finalizarComTicket NÃO agenda aviso de inatividade (ticket já registrado, bot não espera resposta)", async () => {
    await sessionService.finalizarComTicket("user-pos-ticket", {
      protocolo: "2026-9999"
    });

    await esperar(700);

    expect(sendMessage).not.toHaveBeenCalled();
  }, 10000);

  test("finalizarComTicket cancela um timer de aviso que já estava pendente daquele mesmo cliente", async () => {
    // Cliente estava no meio do fluxo (timer de aviso agendado pra 300ms)...
    await sessionService.updateSession("user-cancela-pendente", {
      sector: "vendas",
      step: "aguardando_veiculo"
    });

    // ...e o pedido é finalizado bem antes disso (100ms) — cancela o timer
    // pendente em vez de deixá-lo disparar.
    await esperar(100);
    await sessionService.finalizarComTicket("user-cancela-pendente", {
      protocolo: "2026-8888"
    });

    // Espera passar do ponto em que TANTO o aviso (300ms) quanto o
    // encerramento (600ms) teriam disparado, caso não tivessem sido cancelados.
    await esperar(700);

    expect(sendMessage).not.toHaveBeenCalled();
  }, 10000);

  test("aiHistorico e customerName continuam preservados após finalizarComTicket (comportamento pré-existente não deve quebrar)", async () => {
    await sessionService.updateSession("user-historico", {
      customerName: "Cliente Teste",
      aiHistorico: [{ role: "user", parts: [{ text: "oi" }] }]
    });

    await sessionService.finalizarComTicket("user-historico", {
      protocolo: "2026-7777"
    });

    const sessao = sessionService.getSession("user-historico");
    expect(sessao.customerName).toBe("Cliente Teste");
    expect(sessao.sector).toBeUndefined();
    expect(sessao.aiHistorico.length).toBe(2); // mensagem original + nota sintética do ticket
  });
});
