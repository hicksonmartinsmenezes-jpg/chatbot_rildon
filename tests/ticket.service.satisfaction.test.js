/**
 * Testes de parseSatisfactionRating/handleSatisfactionReply (ticket.service.js)
 * — pesquisa de satisfação automática ao fechar um atendimento (pedido do
 * usuário: "uma pesquisa de satisfação ao fechar atendimento?", nota de 1 a
 * 5). handleSatisfactionReply é chamado por message.service.js ANTES de
 * reopenTicketIfClosed, pra que a resposta do cliente ("5") não seja
 * confundida com um pedido novo — ver tests/message.service.test.js para a
 * integração completa no pipeline de mensagens.
 *
 * BUG CORRIGIDO (relatado pelo usuário em teste real: "1" digitado pra
 * escolher o menu foi engolido como nota 1 estrela de uma pesquisa de
 * satisfação de um atendimento anterior, sem relação nenhuma com a
 * conversa atual): o guard antigo olhava só pro banco (ticket resolvido +
 * pesquisa pendente + até 48h desde o envio) — então QUALQUER dígito 1-5
 * do mesmo cliente dentro dessa janela, em qualquer conversa nova, era
 * interceptado como resposta da pesquisa. Agora também exige a flag de
 * sessão aguardandoNotaSatisfacao, setada só no momento exato em que a
 * pesquisa é entregue (ver ticket.controller.js) e limpa na primeira
 * resposta seguinte — cobrindo isso com os testes abaixo.
 *
 * parseSatisfactionRating é testado isoladamente (função pura); os testes de
 * handleSatisfactionReply mockam ticketRepository/settings/lid-map/session.
 */
jest.mock("../src/repositories/ticket.repository", () => ({
  findByUserIds: jest.fn(),
  rateSatisfaction: jest.fn(),
  saveSatisfactionFeedback: jest.fn()
}));
jest.mock("../src/whatsapp/lid-map", () => ({
  getProfilePhotoCandidates: jest.fn(userId => [userId])
}));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    atendimento: {
      mensagemAgradecimentoPesquisa: "Muito obrigado pela sua avaliação!",
      mensagemPedirMelhoria: "Poxa, sentimos muito! O que podemos melhorar?"
    }
  })
}));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/services/session.service", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn().mockResolvedValue(undefined),
}));

const ticketRepository = require("../src/repositories/ticket.repository");
const settingsService = require("../src/services/settings.service");
const sessionService = require("../src/services/session.service");
const { parseSatisfactionRating, handleSatisfactionReply } = require("../src/services/ticket.service");

function ticketPendente(overrides = {}) {
  return {
    id: 42,
    protocolo: "2026-0042",
    userId: "cliente-1",
    status: "resolvido",
    satisfactionRating: null,
    satisfactionAskedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("parseSatisfactionRating", () => {
  test.each([
    ["5", 5],
    ["nota 5", 5],
    ["5/5", 5],
    ["5 estrelas", 5],
    ["1", 1],
    [" 3 ", 3]
  ])("reconhece nota válida em %j", (texto, esperado) => {
    expect(parseSatisfactionRating(texto)).toBe(esperado);
  });

  test.each([
    ["0"],       // fora do range 1-5
    ["6"],       // fora do range 1-5
    ["55"],      // dois dígitos adjacentes — não é uma nota isolada
    [""],
    [null],
    [undefined],
    ["1".repeat(31)] // texto longo demais (>30 chars) mesmo contendo dígito válido
  ])("NÃO reconhece nota em %j", (texto) => {
    expect(parseSatisfactionRating(texto)).toBeNull();
  });

  // Caso real que motivou o limite de 30 chars: um CPF digitado por engano
  // não pode ser lido como nota só porque contém um dígito 1-5 em algum lugar.
  test("não confunde um CPF longo (com dígito 1-5 no meio) com uma nota", () => {
    expect(parseSatisfactionRating("123.456.789-01 (esse é meu CPF)")).toBeNull();
  });
});

describe("handleSatisfactionReply", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    settingsService.getSettings.mockResolvedValue({
      atendimento: { mensagemAgradecimentoPesquisa: "Muito obrigado pela sua avaliação!" }
    });
    // Padrão: sessão SEM a flag — a maioria dos testes abaixo liga
    // explicitamente quando quer simular "acabou de receber a pesquisa".
    sessionService.getSession.mockReturnValue({});
  });

  test("sem a flag de sessão aguardandoNotaSatisfacao → retorna null sem nem consultar o banco (bug corrigido)", async () => {
    // Esse é exatamente o cenário relatado: cliente digita "1" pra
    // escolher o menu, dias depois de uma pesquisa não respondida — sem a
    // flag (sessão já foi limpa por uma saudação, navegação, etc.), a
    // pesquisa antiga no banco não deve mais interceptar nada.
    sessionService.getSession.mockReturnValue({}); // sem aguardandoNotaSatisfacao
    ticketRepository.findByUserIds.mockResolvedValue([ticketPendente()]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "1" });

    expect(res).toBeNull();
    expect(ticketRepository.findByUserIds).not.toHaveBeenCalled();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("com a flag ativa + sem ticket resolvido pendente → retorna null, limpa a flag", async () => {
    sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
    ticketRepository.findByUserIds.mockResolvedValueOnce([]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
    expect(sessionService.updateSession).toHaveBeenCalledWith(
      "cliente-1",
      { aguardandoNotaSatisfacao: undefined },
      { skipTimer: true }
    );
  });

  test("com a flag ativa + pesquisa pendente + nota válida → registra, agradece e limpa a flag", async () => {
    sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
    const pendente = ticketPendente();
    ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);
    ticketRepository.rateSatisfaction.mockResolvedValueOnce({ ...pendente, satisfactionRating: 5 });

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(ticketRepository.rateSatisfaction).toHaveBeenCalledWith(42, 5);
    expect(res).toMatchObject({ rating: 5, response: "Muito obrigado pela sua avaliação!" });
    expect(sessionService.updateSession).toHaveBeenCalledWith(
      "cliente-1",
      { aguardandoNotaSatisfacao: undefined },
      { skipTimer: true }
    );
  });

  test("com a flag ativa + mensagem NÃO é uma nota reconhecível → retorna null, limpa a flag mesmo assim", async () => {
    sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
    const pendente = ticketPendente();
    ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "obrigado pelo atendimento!" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
    expect(sessionService.updateSession).toHaveBeenCalledWith(
      "cliente-1",
      { aguardandoNotaSatisfacao: undefined },
      { skipTimer: true }
    );
  });

  test("ticket já avaliado (satisfactionRating preenchido) não conta como pendente, mesmo com a flag ativa", async () => {
    sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
    const jaAvaliado = ticketPendente({ satisfactionRating: 4 });
    ticketRepository.findByUserIds.mockResolvedValueOnce([jaAvaliado]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("pesquisa expirada (fora da janela de 48h) não conta como pendente, mesmo com a flag ativa", async () => {
    sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
    const antigo = ticketPendente({
      satisfactionAskedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString()
    });
    ticketRepository.findByUserIds.mockResolvedValueOnce([antigo]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
    expect(ticketRepository.rateSatisfaction).not.toHaveBeenCalled();
  });

  test("ticket ainda não resolvido (em_andamento) não conta como pendente mesmo com satisfactionAskedAt e flag ativa", async () => {
    sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
    const emAndamento = ticketPendente({ status: "em_andamento" });
    ticketRepository.findByUserIds.mockResolvedValueOnce([emAndamento]);

    const res = await handleSatisfactionReply({ userId: "cliente-1", message: "5" });

    expect(res).toBeNull();
  });

  // Pedido do usuário (2026-07-21): nota baixa (1 ou 2) não agradece direto —
  // pergunta "o que podemos melhorar?" primeiro, e só a mensagem seguinte é
  // o feedback livre salvo no ticket (ver saveSatisfactionFeedback).
  describe("nota baixa → pergunta o que pode melhorar antes de agradecer", () => {
    test("nota 2 → registra a nota, NÃO agradece ainda, pergunta o que pode melhorar", async () => {
      sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
      const pendente = ticketPendente();
      ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);
      ticketRepository.rateSatisfaction.mockResolvedValueOnce({ ...pendente, id: 42, satisfactionRating: 2 });

      const res = await handleSatisfactionReply({ userId: "cliente-1", message: "2" });

      expect(ticketRepository.rateSatisfaction).toHaveBeenCalledWith(42, 2);
      expect(res).toMatchObject({ rating: 2, response: "Poxa, sentimos muito! O que podemos melhorar?" });
      expect(sessionService.updateSession).toHaveBeenCalledWith(
        "cliente-1",
        {
          aguardandoNotaSatisfacao: undefined,
          aguardandoFeedbackSatisfacao: true,
          ticketFeedbackPendente: 42,
        },
        { skipTimer: true }
      );
    });

    test("nota 1 (pior nota) também dispara a pergunta de melhoria", async () => {
      sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
      const pendente = ticketPendente();
      ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);
      ticketRepository.rateSatisfaction.mockResolvedValueOnce({ ...pendente, id: 42, satisfactionRating: 1 });

      const res = await handleSatisfactionReply({ userId: "cliente-1", message: "1" });

      expect(res).toMatchObject({ rating: 1, response: "Poxa, sentimos muito! O que podemos melhorar?" });
    });

    test("nota 3 (neutra) NÃO dispara a pergunta de melhoria — agradece direto como nota alta", async () => {
      sessionService.getSession.mockReturnValue({ aguardandoNotaSatisfacao: true });
      const pendente = ticketPendente();
      ticketRepository.findByUserIds.mockResolvedValueOnce([pendente]);
      ticketRepository.rateSatisfaction.mockResolvedValueOnce({ ...pendente, id: 42, satisfactionRating: 3 });

      const res = await handleSatisfactionReply({ userId: "cliente-1", message: "3" });

      expect(res).toMatchObject({ rating: 3, response: "Muito obrigado pela sua avaliação!" });
      expect(sessionService.updateSession).toHaveBeenCalledWith(
        "cliente-1",
        { aguardandoNotaSatisfacao: undefined },
        { skipTimer: true }
      );
    });

    test("mensagem seguinte (com a flag aguardandoFeedbackSatisfacao) → salva o texto livre e agradece", async () => {
      sessionService.getSession.mockReturnValue({
        aguardandoFeedbackSatisfacao: true,
        ticketFeedbackPendente: 42,
      });
      ticketRepository.saveSatisfactionFeedback.mockResolvedValueOnce({ id: 42, satisfactionFeedback: "Demorou muito pra responder" });

      const res = await handleSatisfactionReply({ userId: "cliente-1", message: "Demorou muito pra responder" });

      expect(ticketRepository.saveSatisfactionFeedback).toHaveBeenCalledWith(42, "Demorou muito pra responder");
      expect(res).toMatchObject({ rating: null, response: "Muito obrigado pela sua avaliação!" });
      expect(sessionService.updateSession).toHaveBeenCalledWith(
        "cliente-1",
        { aguardandoFeedbackSatisfacao: undefined, ticketFeedbackPendente: undefined },
        { skipTimer: true }
      );
      // Não deve consultar tickets pendentes de nota nesta etapa — já não é
      // mais sobre a nota, é a captura do texto livre.
      expect(ticketRepository.findByUserIds).not.toHaveBeenCalled();
    });

    test("mensagem de feedback é sanitizada (limite de 500 chars) antes de salvar", async () => {
      sessionService.getSession.mockReturnValue({
        aguardandoFeedbackSatisfacao: true,
        ticketFeedbackPendente: 42,
      });
      ticketRepository.saveSatisfactionFeedback.mockResolvedValueOnce({ id: 42 });
      const textoGigante = "a".repeat(600);

      await handleSatisfactionReply({ userId: "cliente-1", message: textoGigante });

      const [, textoSalvo] = ticketRepository.saveSatisfactionFeedback.mock.calls[0];
      expect(textoSalvo.length).toBe(500);
    });

    test("flag aguardandoFeedbackSatisfacao sem ticketFeedbackPendente → não chama saveSatisfactionFeedback, mas ainda agradece", async () => {
      sessionService.getSession.mockReturnValue({ aguardandoFeedbackSatisfacao: true });

      const res = await handleSatisfactionReply({ userId: "cliente-1", message: "melhorar o atendimento" });

      expect(ticketRepository.saveSatisfactionFeedback).not.toHaveBeenCalled();
      expect(res).toMatchObject({ rating: null, response: "Muito obrigado pela sua avaliação!" });
    });

    // Pedido do usuário (2026-07-21): mesma classe de bug já corrigida antes
    // (pergunta de crediário engolida como nome, correção de peça engolida
    // como veículo) — aqui a etapa de captura de feedback não pode engolir
    // um cliente que só quis voltar/navegar em vez de responder.
    describe("escape de navegação NÃO deve ser salvo como feedback (proteção contra engolir mensagem)", () => {
      test.each(["0", "menu", "Menu!", "voltar", "cancelar", "oi", "bom dia", "1", "3."])(
        "'%s' → não salva como feedback, retorna null e deixa o fluxo normal seguir",
        async (mensagem) => {
          sessionService.getSession.mockReturnValue({
            aguardandoFeedbackSatisfacao: true,
            ticketFeedbackPendente: 42,
          });

          const res = await handleSatisfactionReply({ userId: "cliente-1", message: mensagem });

          expect(res).toBeNull();
          expect(ticketRepository.saveSatisfactionFeedback).not.toHaveBeenCalled();
          expect(sessionService.updateSession).toHaveBeenCalledWith(
            "cliente-1",
            { aguardandoFeedbackSatisfacao: undefined, ticketFeedbackPendente: undefined },
            { skipTimer: true }
          );
        }
      );

      test("texto de feedback real que por acaso menciona um número não é confundido com escape", async () => {
        sessionService.getSession.mockReturnValue({
          aguardandoFeedbackSatisfacao: true,
          ticketFeedbackPendente: 42,
        });
        ticketRepository.saveSatisfactionFeedback.mockResolvedValueOnce({ id: 42 });

        const res = await handleSatisfactionReply({
          userId: "cliente-1",
          message: "demorou 1 semana pra me responder",
        });

        expect(ticketRepository.saveSatisfactionFeedback).toHaveBeenCalledWith(42, "demorou 1 semana pra me responder");
        expect(res).not.toBeNull();
      });
    });
  });
});
