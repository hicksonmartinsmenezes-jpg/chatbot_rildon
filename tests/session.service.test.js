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
 *
 * Segundo bug coberto aqui: o mesmo cliente físico pode chegar com userId
 * DIFERENTE entre mensagens (WhatsApp entrega às vezes como "...@lid" ainda
 * não resolvido, às vezes já resolvido pro número "...@s.whatsapp.net" —
 * ver LID_FALLBACK em src/config/whatsapp.js). Sem tratar isso, uma sessão
 * em andamento (nome/veículo já coletados) "sumia" quando a mensagem
 * seguinte chegava com a outra variante da chave — o bot voltava a
 * perguntar tudo do zero. Fix: getSession/updateSession/clearSession agora
 * checam as variantes lid/jid conhecidas (getProfilePhotoCandidates, mesmo
 * mecanismo já usado em ticket.repository/humanMode.service/etc) e
 * consolidam a sessão pra chave atual em vez de fragmentar.
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
const { setLidMapping } = require("../src/whatsapp/lid-map");

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
  }, 20000);

  test("finalizarComTicket NÃO agenda aviso de inatividade (ticket já registrado, bot não espera resposta)", async () => {
    await sessionService.finalizarComTicket("user-pos-ticket", {
      protocolo: "2026-9999"
    });

    await esperar(700);

    expect(sendMessage).not.toHaveBeenCalled();
  }, 20000);

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
  }, 20000);

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

describe("session.service — consolidação de sessão entre chaves @lid e @s.whatsapp.net", () => {
  beforeEach(async () => {
    await sessionService.setSendMessage(jest.fn().mockResolvedValue(undefined));
  });

  test("getSession encontra a sessão salva sob a chave @s.whatsapp.net quando a mensagem chega pela chave @lid equivalente", async () => {
    setLidMapping("111@lid", "5579990000001@s.whatsapp.net");

    await sessionService.updateSession("5579990000001@s.whatsapp.net", {
      customerName: "Hickson martins",
    });

    const sessao = sessionService.getSession("111@lid");
    expect(sessao.customerName).toBe("Hickson martins");
  });

  test("getSession encontra a sessão salva sob a chave @lid quando a mensagem chega já resolvida (@s.whatsapp.net)", async () => {
    setLidMapping("222@lid", "5579990000002@s.whatsapp.net");

    await sessionService.updateSession("222@lid", {
      customerName: "Ana",
      veiculoSugerido: "Fiat Palio",
    });

    const sessao = sessionService.getSession("5579990000002@s.whatsapp.net");
    expect(sessao.customerName).toBe("Ana");
    expect(sessao.veiculoSugerido).toBe("Fiat Palio");
  });

  test("updateSession consolida a sessão pra chave atual em vez de fragmentar em duas cópias divergentes", async () => {
    setLidMapping("333@lid", "5579990000003@s.whatsapp.net");

    // 1ª mensagem chega pelo @lid (ainda não resolvido no momento do envio)
    await sessionService.updateSession("333@lid", {
      customerName: "Carla",
      sector: "vendas",
      step: "aguardando_veiculo",
    });

    // 2ª mensagem do MESMO cliente chega já resolvida — deve continuar a
    // MESMA sessão (não recomeçar do zero) e consolidar pra essa chave.
    await sessionService.updateSession("5579990000003@s.whatsapp.net", {
      step: "aguardando_orcamento",
    });

    // 3ª atualização, agora só pela chave nova (resolvida) — se a
    // consolidação realmente aconteceu (em vez de manter duas cópias
    // divergentes), consultar pela chave ANTIGA deve refletir esta
    // atualização mais recente também.
    await sessionService.updateSession("5579990000003@s.whatsapp.net", {
      step: "aguardando_confirmacao",
    });

    const sessaoNova = sessionService.getSession("5579990000003@s.whatsapp.net");
    const sessaoAntiga = sessionService.getSession("333@lid");

    expect(sessaoNova.customerName).toBe("Carla");
    expect(sessaoNova.step).toBe("aguardando_confirmacao");
    expect(sessaoAntiga.customerName).toBe("Carla");
    expect(sessaoAntiga.step).toBe("aguardando_confirmacao");
  });

  test("clientes diferentes (sem mapeamento lid/jid entre eles) continuam com sessões independentes", async () => {
    await sessionService.updateSession("5579990000010@s.whatsapp.net", {
      customerName: "Cliente A",
    });
    await sessionService.updateSession("5579990000020@s.whatsapp.net", {
      customerName: "Cliente B",
    });

    expect(sessionService.getSession("5579990000010@s.whatsapp.net").customerName).toBe("Cliente A");
    expect(sessionService.getSession("5579990000020@s.whatsapp.net").customerName).toBe("Cliente B");
  });
});
