/**
 * Testes de ai.service.js — foco no novo provedor "anthropic" (Claude),
 * adicionado a pedido do usuário como alternativa de melhor qualidade aos
 * provedores free tier (groq/gemini) já existentes.
 *
 * PROVIDER_NAME é resolvido a partir de process.env.AI_PROVIDER no momento
 * em que o módulo é carregado — por isso cada teste que precisa de um
 * provedor diferente usa jest.resetModules() e re-exige o módulo depois de
 * ajustar a env var, em vez de só trocar em runtime.
 *
 * global.fetch é mockado; a leitura dos arquivos de treinamento (pasta
 * training/) roda de verdade — o conteúdo não é testado aqui, só a forma
 * da requisição HTTP e a extração da resposta.
 */

const ORIGINAL_ENV = { ...process.env };

function loadAiService({ provider, apiKey } = {}) {
  jest.resetModules();
  if (provider !== undefined) process.env.AI_PROVIDER = provider;
  if (apiKey !== undefined) process.env.ANTHROPIC_API_KEY = apiKey;
  return require("../src/services/ai.service");
}

describe("ai.service — provedor anthropic (Claude)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  test("sem ANTHROPIC_API_KEY configurada (ou placeholder) → retorna null sem chamar fetch", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "" });

    const res = await perguntarIA("Olá, tudo bem?", {});

    expect(res).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("monta a requisição no formato da Anthropic Messages API (url, headers, modelo, prefill JSON)", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '"resposta":"Olá! Como posso ajudar?","intencao":"chat"}' }],
      }),
    });

    const res = await perguntarIA("Oi", { nomeCliente: "Maria" });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];

    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers["x-api-key"]).toBe("sk-ant-teste-123");
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(options.body);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(typeof body.system).toBe("string");
    expect(body.system.length).toBeGreaterThan(0);
    // Última mensagem é o prefill "{" que força o início do JSON.
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "assistant", content: "{" });
    // Mensagem do usuário presente com o texto enviado.
    expect(body.messages.some(m => m.role === "user" && m.content === "Oi")).toBe(true);

    expect(res).toEqual({ resposta: "Olá! Como posso ajudar?", intencao: "chat", veiculo: null, peca: null, pedidoExplicito: false });
  });

  test("recompõe o '{' do prefill antes de extrair o JSON da resposta", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    // A Anthropic NÃO devolve o prefixo "{" enviado no prefill — só o restante.
    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '"resposta":"Temos sim, chega amanhã!","intencao":"vendas"}' }],
      }),
    });

    const res = await perguntarIA("Vocês tem pastilha de freio pro Onix?", {});

    expect(res).toEqual({ resposta: "Temos sim, chega amanhã!", intencao: "vendas", veiculo: null, peca: null, pedidoExplicito: false });
  });

  test("historico com role 'model' é convertido para 'assistant' nas mensagens enviadas", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '"resposta":"Perfeito!","intencao":"chat"}' }],
      }),
    });

    await perguntarIA("E a segunda opção?", {
      historico: [
        { role: "user",  parts: [{ text: "Qual o preço da bateria?" }] },
        { role: "model", parts: [{ text: "Temos duas opções, 60Ah e 70Ah." }] },
      ],
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages.some(m => m.role === "assistant" && m.content === "Temos duas opções, 60Ah e 70Ah.")).toBe(true);
  });

  test("intenção fora da lista válida cai para 'chat'", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '"resposta":"Ok!","intencao":"inexistente"}' }],
      }),
    });

    const res = await perguntarIA("teste", {});
    expect(res).toEqual({ resposta: "Ok!", intencao: "chat", veiculo: null, peca: null, pedidoExplicito: false });
  });

  // Pedido do usuário: quando o cliente já menciona o veículo na 1ª
  // mensagem (ex: "motor de partida fiat palio 2025"), main.flow.js usa o
  // campo "veiculo" pra pular a pergunta redundante "qual o veículo?".
  describe("campo 'veiculo' (extração pra pular pergunta redundante)", () => {
    test("extrai o veículo quando a IA retorna o campo preenchido", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Já te ajudo com isso!","intencao":"vendas","veiculo":"Fiat Palio 2025"}' }],
        }),
      });

      const res = await perguntarIA("motor de partida fiat palio 2025", {});
      expect(res).toEqual({ resposta: "Já te ajudo com isso!", intencao: "vendas", veiculo: "Fiat Palio 2025", peca: null, pedidoExplicito: false });
    });

    test("veiculo null quando a IA não identifica o veículo na mensagem", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Já te ajudo!","intencao":"vendas","veiculo":null}' }],
        }),
      });

      const res = await perguntarIA("preciso de uma buzina", {});
      expect(res.veiculo).toBeNull();
    });

    test("veiculo com string vazia ou só espaços é tratado como null", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"vendas","veiculo":"   "}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.veiculo).toBeNull();
    });

    test("veiculo com tipo inesperado (não-string) é tratado como null, sem quebrar o parse", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"vendas","veiculo":123}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.veiculo).toBeNull();
      expect(res.resposta).toBe("Ok!");
    });

    test("campo 'veiculo' ausente por completo na resposta (compatibilidade) → null", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"chat"}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.veiculo).toBeNull();
    });
  });

  // Pedido do usuário (relatado após o primeiro ajuste do veículo): a
  // descrição do ticket ficava com a frase inteira do cliente, saudação
  // incluída — "peca" permite à IA isolar só o nome da peça, igual já
  // fazia com "veiculo".
  describe("campo 'peca' (nome limpo da peça, sem saudação/veículo)", () => {
    test("extrai a peça quando a IA retorna o campo preenchido", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Já te ajudo!","intencao":"vendas","veiculo":"Fiat 2025","peca":"Motor de partida"}' }],
        }),
      });

      const res = await perguntarIA("Bom dia, motor de partida fiat 2025", {});
      expect(res).toEqual({
        resposta: "Já te ajudo!",
        intencao: "vendas",
        veiculo: "Fiat 2025",
        peca: "Motor de partida",
        pedidoExplicito: false,
      });
    });

    test("peca null quando a IA não identifica uma peça específica", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Pode me dar mais detalhes?","intencao":"vendas","veiculo":null,"peca":null}' }],
        }),
      });

      const res = await perguntarIA("preciso de uma peça", {});
      expect(res.peca).toBeNull();
    });

    test("peca com string vazia ou tipo inesperado é tratada como null", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"vendas","peca":"   "}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.peca).toBeNull();
    });

    test("campo 'peca' ausente por completo na resposta (compatibilidade) → null", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"chat"}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.peca).toBeNull();
    });
  });

  // Pedido do usuário (bug real: ticket #2026-0056 — cliente perguntou "tem
  // motor de partida fiat palio?" e o sistema criou o orçamento sozinho,
  // sem nenhuma confirmação). "pedidoExplicito" distingue um pedido real
  // ("quero orçamento", "quero comprar") de uma simples pergunta/consulta
  // ("tem X?", "vocês trabalham com X?") — main.flow.js só auto-avança
  // (pula perguntas / cria ticket direto) quando este campo é true.
  describe("campo 'pedidoExplicito' (evita ticket automático em simples pergunta)", () => {
    test("true quando a IA identifica um pedido explícito de orçamento/compra", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Perfeito, já te ajudo!","intencao":"vendas","pedidoExplicito":true}' }],
        }),
      });

      const res = await perguntarIA("quero orçamento de um alternador", {});
      expect(res.pedidoExplicito).toBe(true);
    });

    test("false quando o cliente só pergunta disponibilidade, sem pedir nada", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Sim, trabalhamos com motor de partida pro Palio!","intencao":"vendas","veiculo":"Fiat Palio","peca":"Motor de partida","pedidoExplicito":false}' }],
        }),
      });

      const res = await perguntarIA("tem motor de partida fiat palio?", {});
      expect(res.pedidoExplicito).toBe(false);
    });

    test("campo ausente por completo na resposta (compatibilidade) → false, nunca undefined", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"vendas"}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.pedidoExplicito).toBe(false);
    });

    test("valor não-booleano (ex: string 'true') é tratado como false — só true === true conta", async () => {
      const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ text: '"resposta":"Ok!","intencao":"vendas","pedidoExplicito":"true"}' }],
        }),
      });

      const res = await perguntarIA("teste", {});
      expect(res.pedidoExplicito).toBe(false);
    });
  });

  test("HTTP 500 (sem sucesso em nenhuma tentativa) retorna null", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => "erro interno",
    });

    const res = await perguntarIA("teste", {});
    expect(res).toBeNull();
    // MAX_TENTATIVAS = 2
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000); // retry real (3s) entre tentativas — timeout maior evita flakiness
});

describe("ai.service — seleção de provedor via AI_PROVIDER", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  test('AI_PROVIDER="groq" (ou ausente) continua chamando a API do Groq normalmente', async () => {
    process.env.GROQ_API_KEY = "chave-groq-teste";
    const { perguntarIA } = loadAiService({ provider: "groq" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '{"resposta":"oi","intencao":"chat"}' } }],
      }),
    });

    const res = await perguntarIA("oi", {});

    expect(global.fetch.mock.calls[0][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(res).toEqual({ resposta: "oi", intencao: "chat", veiculo: null, peca: null, pedidoExplicito: false });
  });

  test('AI_PROVIDER="gemini" continua chamando a API do Gemini normalmente', async () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { perguntarIA } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '{"resposta":"oi","intencao":"chat"}' }] } }],
      }),
    });

    const res = await perguntarIA("oi", {});

    expect(global.fetch.mock.calls[0][0]).toContain("generativelanguage.googleapis.com");
    expect(res).toEqual({ resposta: "oi", intencao: "chat", veiculo: null, peca: null, pedidoExplicito: false });
  });
});
