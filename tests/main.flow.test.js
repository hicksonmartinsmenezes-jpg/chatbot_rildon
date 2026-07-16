/**
 * Testes de main.flow.js — foco no roteamento da intenção "vendas" quando a
 * IA já extrai o veículo da própria mensagem inicial (pedido do usuário:
 * "motor de partida fiat palio 2025" não deveria perguntar de novo "qual o
 * veículo?" já que o cliente disse tudo de uma vez).
 *
 * vendas.flow.js é mockado por inteiro aqui — o handoff (main.flow.js chama
 * vendasFlow.finalizarOrcamento com os argumentos certos, ou guarda
 * veiculoInicial/produtoInicial na sessão pra vendas.flow.js pegar depois)
 * é o que se testa neste arquivo. O comportamento REAL de vendas.flow.js
 * (o que ele faz com veiculoInicial) é coberto em tests/vendas.flow.test.js.
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
jest.mock("../src/flows/vendas.flow", () => {
  const fn = jest.fn().mockResolvedValue(null);
  fn.finalizarOrcamento = jest.fn().mockResolvedValue("✅ *Orçamento registrado!* Protocolo #2026-0099");
  return fn;
});
jest.mock("../src/flows/crediario.flow", () => jest.fn().mockResolvedValue(null));

const sessionService = require("../src/services/session.service");
const { perguntarIA } = require("../src/services/ai.service");
const vendasFlow = require("../src/flows/vendas.flow");
const MSG = require("../src/flows/messages");
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

describe("mainFlow — intenção vendas com veículo extraído pela IA", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("nome já conhecido + IA extrai o veículo → finaliza o orçamento direto, sem perguntar veículo", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins" });
    perguntarIA.mockResolvedValue({
      resposta: "Claro, posso te ajudar com isso! 🔧",
      intencao: "vendas",
      veiculo: "Fiat Palio 2025",
      pedidoExplicito: true,
    });

    const resposta = await mainFlow({ userId: USER_ID, message: "motor de partida fiat palio 2025" });

    expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
      USER_ID,
      { customerName: "Hickson Martins" },
      "Fiat Palio 2025",
      "motor de partida fiat palio 2025"
    );
    expect(resposta).toContain("Claro, posso te ajudar com isso!");
    expect(resposta).toContain("Orçamento registrado");
    expect(resposta).not.toContain(MSG.vendas.PEDIR_VEICULO);
    expect(resposta).not.toContain("Qual o *veículo*");

    // vendasFlow "normal" (sub-menu/perguntas) não deve ter sido chamado —
    // só o atalho finalizarOrcamento.
    expect(vendasFlow).not.toHaveBeenCalled();
  });

  test("persiste o histórico da IA ANTES de finalizar (finalizarComTicket precisa ver a troca atual)", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins" });
    perguntarIA.mockResolvedValue({
      resposta: "Fechado!",
      intencao: "vendas",
      veiculo: "Gol 2018",
      pedidoExplicito: true,
    });

    await mainFlow({ userId: USER_ID, message: "alternador gol 2018" });

    const updateCallOrder = sessionService.updateSession.mock.invocationCallOrder[0];
    const finalizarCallOrder = vendasFlow.finalizarOrcamento.mock.invocationCallOrder[0];
    expect(updateCallOrder).toBeLessThan(finalizarCallOrder);

    expect(sessionService.updateSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ customerName: "Hickson Martins" })
    );
  });

  test("nome AINDA não conhecido + IA extrai veículo → guarda veiculoInicial/produtoInicial e pergunta só o nome (não finaliza ainda)", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main" });
    perguntarIA.mockResolvedValue({
      resposta: "Posso te ajudar com o orçamento!",
      intencao: "vendas",
      veiculo: "Onix 2020",
      pedidoExplicito: true,
    });

    const resposta = await mainFlow({ userId: USER_ID, message: "pastilha de freio onix 2020" });

    expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    expect(resposta).toContain(MSG.vendas.PEDIR_NOME);

    expect(sessionService.updateSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        sector: "vendas",
        step: "aguardando_nome",
        produtoInicial: "pastilha de freio onix 2020",
        veiculoInicial: "Onix 2020",
      })
    );
  });

  test("IA NÃO extrai veículo (retorna null) → comportamento antigo preservado (pergunta veículo quando nome já é conhecido)", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Ana" });
    perguntarIA.mockResolvedValue({
      resposta: "Posso ajudar!",
      intencao: "vendas",
      veiculo: null,
      pedidoExplicito: true,
    });

    const resposta = await mainFlow({ userId: USER_ID, message: "preciso de uma buzina" });

    expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    expect(resposta).toContain(MSG.vendas.PEDIR_VEICULO);
    expect(sessionService.updateSession).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ sector: "vendas", step: "aguardando_veiculo", produtoInicial: "preciso de uma buzina" })
    );
  });

  test("mensagem curta demais (< 5 chars normalizados) não conta como produto descritivo mesmo com veículo extraído", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Ana" });
    // Cenário hipotético: IA extrai veículo de uma mensagem quase vazia — não
    // deveria confiar nisso pra pular a pergunta (mesmo limiar de
    // vendas.flow.js: >=5 chars).
    perguntarIA.mockResolvedValue({
      resposta: "Oi!",
      intencao: "vendas",
      veiculo: "Gol",
    });

    await mainFlow({ userId: USER_ID, message: "oi" });

    expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
  });

  test("provedor de IA sem suporte a 'veiculo' (campo undefined) não quebra — trata como não extraído", async () => {
    sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Carla" });
    // Simula um mock antigo de perguntarIA que não retorna o campo veiculo
    // (compatibilidade retroativa).
    perguntarIA.mockResolvedValue({ resposta: "Posso ajudar!", intencao: "vendas", pedidoExplicito: true });

    const resposta = await mainFlow({ userId: USER_ID, message: "preciso de um farol" });

    expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    expect(resposta).toContain(MSG.vendas.PEDIR_VEICULO);
  });

  // Pedido do usuário (relatado após o primeiro ajuste): o ticket ficava
  // com "Produto: Bom dia, motor de partida fiat 2025" — a frase inteira,
  // saudação incluída. Quando a IA isola o nome da peça (campo "peca"),
  // isso deve ser usado na descrição em vez da mensagem crua.
  describe("campo 'peca' — descrição limpa do ticket", () => {
    test("peca extraída + nome conhecido → finaliza usando a peça limpa, não a mensagem crua", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins" });
      perguntarIA.mockResolvedValue({
        resposta: "Bom dia! Já te ajudo com isso!",
        intencao: "vendas",
        veiculo: "Fiat Uno 2025",
        peca: "Motor de partida",
        pedidoExplicito: true,
      });

      await mainFlow({ userId: USER_ID, message: "Bom dia, motor de partida fiat uno 2025" });

      expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
        USER_ID,
        { customerName: "Hickson Martins" },
        "Fiat Uno 2025",
        "Motor de partida" // não a mensagem crua com "Bom dia,"
      );
    });

    test("peca NÃO extraída (null) → cai de volta pra mensagem original (compatibilidade)", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Hickson Martins" });
      perguntarIA.mockResolvedValue({
        resposta: "Já te ajudo!",
        intencao: "vendas",
        veiculo: "Gol 2018",
        peca: null,
        pedidoExplicito: true,
      });

      await mainFlow({ userId: USER_ID, message: "alternador pro meu gol 2018" });

      expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
        USER_ID,
        { customerName: "Hickson Martins" },
        "Gol 2018",
        "alternador pro meu gol 2018"
      );
    });

    test("nome ainda não conhecido → pecaInicial é guardado na sessão junto com veiculoInicial", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main" });
      perguntarIA.mockResolvedValue({
        resposta: "Posso te ajudar!",
        intencao: "vendas",
        veiculo: "Onix 2020",
        peca: "Pastilha de freio",
        pedidoExplicito: true,
      });

      await mainFlow({ userId: USER_ID, message: "pastilha de freio pro onix 2020" });

      expect(sessionService.updateSession).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          veiculoInicial: "Onix 2020",
          pecaInicial: "Pastilha de freio",
        })
      );
    });
  });

  // Pedido do usuário (bug real: ticket #2026-0056 — cliente perguntou "tem
  // motor de partida fiat palio?" e o sistema criou o orçamento sozinho,
  // sem confirmação nenhuma). "pedidoExplicito" (ver ai.service.js) só é
  // true quando o cliente PEDE o orçamento/compra — uma simples pergunta
  // de disponibilidade não deve mais disparar criação automática de ticket.
  describe("campo 'pedidoExplicito' — não cria ticket sozinho em simples pergunta", () => {
    test("pedidoExplicito false → NÃO finaliza nem entra no fluxo de vendas, só responde e guarda sugestão", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Design / Marketing" });
      // Resposta "fechada" (sem "?" no final) — o prompt já instrui a IA a
      // NÃO perguntar ela mesma "quer que eu registre o orçamento?" quando
      // pedidoExplicito é false (isso é papel do sistema, via
      // CONFIRMAR_ORCAMENTO logo abaixo).
      perguntarIA.mockResolvedValue({
        resposta: "Sim, trabalhamos com motor de partida pro Palio! 😊",
        intencao: "vendas",
        veiculo: "Fiat Palio",
        peca: "Motor de partida",
        pedidoExplicito: false,
      });

      const resposta = await mainFlow({ userId: USER_ID, message: "Bom dia, tem motor de partida fiat palio?" });

      expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
      expect(resposta).not.toContain("Orçamento registrado");
      expect(resposta).toContain("Sim, trabalhamos com motor de partida pro Palio!");
      // Pedido do usuário: em vez do menu completo (1-4), pergunta direto se
      // quer o orçamento — mais natural após uma pergunta de disponibilidade.
      expect(resposta).toContain(MSG.vendas.CONFIRMAR_ORCAMENTO);
      expect(resposta).not.toContain("1 - Orçamento / Falar com atendente");

      expect(sessionService.updateSession).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({
          veiculoSugerido: "Fiat Palio",
          pecaSugerido: "Motor de partida",
        })
      );
      // Não muda de sector — cliente continua em modo "chat" livre
      expect(sessionService.updateSession).not.toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ sector: "vendas" })
      );
    });

    test("confirmação numa mensagem seguinte (pedidoExplicito true, sem repetir veículo/peça) reaproveita veiculoSugerido/pecaSugerido", async () => {
      sessionService.getSession.mockReturnValue({
        sector: "main",
        customerName: "Design / Marketing",
        veiculoSugerido: "Fiat Palio",
        pecaSugerido: "Motor de partida",
      });
      // A confirmação em si ("sim, pode ser") não menciona veículo/peça de novo
      perguntarIA.mockResolvedValue({
        resposta: "Show, já registrando!",
        intencao: "vendas",
        veiculo: null,
        peca: null,
        pedidoExplicito: true,
      });

      const resposta = await mainFlow({ userId: USER_ID, message: "sim, pode ser" });

      expect(vendasFlow.finalizarOrcamento).toHaveBeenCalledWith(
        USER_ID,
        { customerName: "Design / Marketing" },
        "Fiat Palio",
        "Motor de partida"
      );
      expect(resposta).toContain("Orçamento registrado");
    });

    test("campo ausente por completo (compatibilidade com mock antigo) → tratado como false, não finaliza", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Ana" });
      perguntarIA.mockResolvedValue({
        resposta: "Temos sim!",
        intencao: "vendas",
        veiculo: "Uno 2015",
      });

      await mainFlow({ userId: USER_ID, message: "tem farol pro uno 2015?" });

      expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    });

    // Cenário relatado pelo usuário testando: quando a IA ainda precisa de
    // mais info (ex: "qual o ano do veículo?"), empilhar a pergunta
    // determinística "quer que eu registre?" em cima da pergunta da IA
    // confundia sobre o que responder. Só oferece a confirmação quando
    // veículo E peça já são conhecidos (extraídos ou sugeridos antes).
    test("veiculo/peca incompletos (IA ainda pergunta algo) → NÃO acrescenta 'quer que eu registre', deixa só a pergunta da IA", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Design / Marketing" });
      perguntarIA.mockResolvedValue({
        resposta: "Vamos ajudar com o orçamento do motor de partida para o T-Cross. Qual o ano do seu veículo?",
        intencao: "vendas",
        veiculo: null,       // "T-Cross" sozinho, sem ano, a IA não considerou completo
        peca: "Motor de partida",
        pedidoExplicito: false,
      });

      const resposta = await mainFlow({ userId: USER_ID, message: "motor de partida t-cross" });

      expect(resposta).toBe("Vamos ajudar com o orçamento do motor de partida para o T-Cross. Qual o ano do seu veículo?");
      expect(resposta).not.toContain(MSG.vendas.CONFIRMAR_ORCAMENTO);
      expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    });

    test("veiculo/peca completos (um extraído agora, outro sugerido antes) → acrescenta a confirmação normalmente", async () => {
      sessionService.getSession.mockReturnValue({
        sector: "main",
        customerName: "Design / Marketing",
        pecaSugerido: "Motor de partida",
      });
      perguntarIA.mockResolvedValue({
        resposta: "Show, achamos aqui!",
        intencao: "vendas",
        veiculo: "T-Cross 2025",
        peca: null,
        pedidoExplicito: false,
      });

      const resposta = await mainFlow({ userId: USER_ID, message: "tem pro t-cross 2025?" });

      expect(resposta).toContain(MSG.vendas.CONFIRMAR_ORCAMENTO);
    });

    // Bug real relatado pelo usuário: "tem motor de partida pra audi a4
    // 2025?" — a IA respondeu de forma confiante e completa, mas não
    // conseguiu extrair veiculo/peca (modelo pouco comum). Com o gate
    // antigo (só oferece confirmação quando os DOIS campos são
    // conhecidos), o cliente ficava sem NENHUM caminho — a resposta não
    // era uma pergunta (não terminava em "?"), então nada indicava que
    // bastava responder "sim" pra registrar o orçamento.
    test("veiculo/peca NÃO extraídos, mas resposta da IA é informativa (não pergunta nada) → acrescenta a confirmação mesmo assim", async () => {
      sessionService.getSession.mockReturnValue({ sector: "main", customerName: "Design / Marketing" });
      perguntarIA.mockResolvedValue({
        resposta: "Trabalhamos com peças pra várias marcas, incluindo Audi. Pra confirmar esse item certinho, o ideal é já registrar um orçamento que nosso consultor confirma disponibilidade e valor pra você.",
        intencao: "vendas",
        veiculo: null,
        peca: null,
        pedidoExplicito: false,
      });

      const resposta = await mainFlow({
        userId: USER_ID,
        message: "Boa tarde, tem motor de partida para audi a4 2025?",
      });

      expect(resposta).toContain(MSG.vendas.CONFIRMAR_ORCAMENTO);
      expect(vendasFlow.finalizarOrcamento).not.toHaveBeenCalled();
    });
  });
});
