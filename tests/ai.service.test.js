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

      // Mensagem deliberadamente sem nenhuma seção/linha real do catálogo
      // x2 (evita "motor de partida", "alternador" etc.) — assim o override
      // determinístico de confirmação de estoque (ver ai.service.js,
      // perguntarIA) não entra em ação e não sobrescreve "resposta" com um
      // produto real, o que quebraria este teste (que quer validar só a
      // extração do campo "veiculo" vindo do JSON mockado da IA, não a
      // busca no catálogo).
      const res = await perguntarIA("preciso de uma peça pro meu fiat palio 2025", {});
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

      // Mesma razão do teste de "veiculo" acima: evita citar seção/linha
      // real do catálogo x2 pra não disparar o override determinístico de
      // estoque e sobrescrever "resposta".
      const res = await perguntarIA("Bom dia, preciso de uma peça pro meu fiat 2025", {});
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
    // MAX_TENTATIVAS = 3 (aumentado de 2 — ver comentário em ai.service.js, item #7)
    expect(global.fetch).toHaveBeenCalledTimes(3);
  }, 15000); // retry real (3s) entre tentativas, agora 2 esperas — timeout maior evita flakiness
});

// PEDIDO DO USUÁRIO (2026-07-27): achado ao vivo em produção — "Your credit
// balance is too low to access the Anthropic API" (HTTP 400) é uma falha
// PERMANENTE até o usuário recarregar o console, bem diferente de um 429/500
// transitório. Sem tratamento especial, cada mensagem de cliente durante a
// falta de crédito gastava uma chamada HTTP fadada a falhar, e main.flow.js
// só escalava pro atendente na 2ª mensagem consecutiva. Circuito: detecta
// esse erro específico, pula a chamada de rede por alguns minutos, e expõe
// iaEmFalhaCritica() pra main.flow.js escalar já na 1ª mensagem.
describe("ai.service — circuit breaker de falta de crédito na API", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  test("HTTP 400 'credit balance is too low' → retorna null numa ÚNICA tentativa (não é erro transitório, não vale a pena repetir)", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    });

    const res = await perguntarIA("teste", {});
    expect(res).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("depois de detectar o erro de crédito, iaEmFalhaCritica() vira true e a PRÓXIMA chamada nem tenta a rede", async () => {
    const { perguntarIA, iaEmFalhaCritica } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}',
    });

    expect(iaEmFalhaCritica()).toBe(false);
    await perguntarIA("primeira mensagem", {});
    expect(iaEmFalhaCritica()).toBe(true);

    global.fetch.mockClear();
    const res2 = await perguntarIA("segunda mensagem, cliente diferente", {});
    expect(res2).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled(); // circuito aberto — nem tenta a rede
  });

  test("HTTP 400 por outro motivo (não é falta de crédito) NÃO ativa o circuito", async () => {
    const { perguntarIA, iaEmFalhaCritica } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => '{"error":{"message":"prompt is too long"}}',
    });

    await perguntarIA("mensagem enorme", {});
    expect(iaEmFalhaCritica()).toBe(false);

    global.fetch.mockClear();
    await perguntarIA("outra mensagem", {});
    expect(global.fetch).toHaveBeenCalledTimes(1); // circuito NÃO ativado — tenta a rede normalmente
  });
});

// BUG CORRIGIDO (relatado pelo usuário, 2026-07-23 — clientes reais em
// produção): o override determinístico "Sim, temos! <produto real>"
// disparava mesmo sem o cliente ter mencionado nenhum veículo, porque
// buscarPorVeiculo() caía num fallback por SEÇÃO que aceitava 1 palavra
// residual qualquer como "sinal de veículo" (ex: "polia" em "Alternador com
// polia"). Reproduzido em produção: pergunta genérica sem veículo devolveu
// "POLIA CITROEN XSARA" (o carro real do cliente era Nissan Frontier);
// fragmento incompleto devolveu "INDUZIDO... TOYOTA MARILIA". Corrigido:
// buscarPorVeiculo só é chamado quando a IA já extraiu um veículo real da
// mensagem (campo "veiculo"). Esses testes mockam catalogo-x2.service
// diretamente (em vez de depender de uma coincidência real nos dados do
// catálogo) pra isolar e travar essa regra especificamente.
describe("ai.service — override de catálogo só dispara com veículo confirmado", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
    jest.dontMock("../src/services/catalogo-x2.service");
  });

  test("sem veículo na mensagem → mesmo que buscarPorVeiculo ache algo (falso positivo de categoria), NÃO sobrescreve a resposta da IA", async () => {
    jest.resetModules();
    jest.doMock("../src/services/catalogo-x2.service", () => ({
      buscarPorCodigoOriginal: jest.fn().mockReturnValue([]),
      // Simula o fallback-por-seção batendo num produto qualquer só por
      // causa de uma palavra residual ("polia") — exatamente o bug real.
      buscarPorVeiculo: jest.fn().mockReturnValue([
        { nome: "POLIA CITROEN XSARA 1.6 16V 2001> - VETOR", referencia: "VT7041", codigo: "999" }
      ]),
    }));
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-123";
    const { perguntarIA } = require("../src/services/ai.service");

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '"resposta":"Trabalhamos com alternador de várias marcas! Qual o veículo?","intencao":"vendas","veiculo":null}' }],
      }),
    });

    const res = await perguntarIA("Alternador com polia", {});

    expect(res.veiculo).toBeNull();
    expect(res.resposta).toBe("Trabalhamos com alternador de várias marcas! Qual o veículo?");
    expect(res.resposta).not.toContain("POLIA CITROEN XSARA");
  });

  test("com veículo confirmado pela IA + buscarPorVeiculo acha o produto → sobrescreve com 'Sim, temos!' (comportamento original preservado)", async () => {
    jest.resetModules();
    const buscarPorVeiculoMock = jest.fn().mockReturnValue([
      { nome: "ALTERNADOR NISSAN FRONTIER 2012 - BOSCH", referencia: "AL123", codigo: "888" }
    ]);
    jest.doMock("../src/services/catalogo-x2.service", () => ({
      buscarPorCodigoOriginal: jest.fn().mockReturnValue([]),
      buscarPorVeiculo: buscarPorVeiculoMock,
    }));
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-123";
    const { perguntarIA } = require("../src/services/ai.service");

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: '"resposta":"Vou verificar pra você.","intencao":"vendas","veiculo":"Nissan Frontier 2012"}' }],
      }),
    });

    const res = await perguntarIA("Alternador do meu Nissan Frontier 2012", {});

    expect(buscarPorVeiculoMock).toHaveBeenCalled();
    expect(res.veiculo).toBe("Nissan Frontier 2012");
    expect(res.resposta).toBe("Sim, temos! 😊 ALTERNADOR NISSAN FRONTIER 2012 - BOSCH (ref. AL123).");
  });
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

/**
 * Pedido do usuário: cliente manda foto de peça pedindo ajuda pelo WhatsApp
 * (task #144/#156). Só Gemini e Anthropic suportam imagem nas APIs já
 * integradas aqui — Groq (llama-3.1-8b-instant) é só texto, então
 * suportaVisao()/analisarImagemPeca() devem se comportar como um no-op
 * silencioso nesse caso (null), nunca lançar erro — quem chama
 * (config/whatsapp.js) usa null como sinal pra manter o aviso padrão de
 * "não processo mídia" já existente.
 *
 * BUG REAL (achado em teste ao vivo, 2026-07-20): antes, suportaVisao() só
 * checava o PROVIDER_NAME do CHAT (gemini/anthropic), sem checar se havia
 * de fato uma chave configurada — e o inverso também era um bug: loja
 * rodando com AI_PROVIDER=groq tinha a visão DESLIGADA mesmo com
 * GEMINI_API_KEY/ANTHROPIC_API_KEY configuradas no .env, porque a checagem
 * dependia do provedor de CHAT, não da chave de visão em si. Corrigido pra
 * checar a chave de qualquer provedor com suporte a imagem, independente do
 * AI_PROVIDER do chat — mesmo padrão que suportaAudio() já usava pra Groq.
 */
describe("ai.service — suportaVisao()", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("groq sem GEMINI_API_KEY/ANTHROPIC_API_KEY → não suporta visão", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { suportaVisao } = loadAiService({ provider: "groq" });
    expect(suportaVisao()).toBe(false);
  });

  test("gemini com GEMINI_API_KEY configurada → suporta visão", () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { suportaVisao } = loadAiService({ provider: "gemini" });
    expect(suportaVisao()).toBe(true);
  });

  test("gemini SEM GEMINI_API_KEY configurada → não suporta visão", () => {
    delete process.env.GEMINI_API_KEY;
    const { suportaVisao } = loadAiService({ provider: "gemini" });
    expect(suportaVisao()).toBe(false);
  });

  test("anthropic com ANTHROPIC_API_KEY configurada → suporta visão", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-123";
    const { suportaVisao } = loadAiService({ provider: "anthropic" });
    expect(suportaVisao()).toBe(true);
  });

  test("chat em groq + GEMINI_API_KEY configurada → visão funciona mesmo assim (decoupling)", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { suportaVisao } = loadAiService({ provider: "groq" });
    expect(suportaVisao()).toBe(true);
  });

  test("chat em groq + ANTHROPIC_API_KEY configurada → visão funciona mesmo assim (decoupling)", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-123";
    const { suportaVisao } = loadAiService({ provider: "groq" });
    expect(suportaVisao()).toBe(true);
  });
});

describe("ai.service — analisarImagemPeca()", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  test("provedor groq (sem suporte a visão) → null sem chamar fetch", async () => {
    process.env.GROQ_API_KEY = "chave-groq-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "groq" });

    const res = await analisarImagemPeca("base64falso", "image/jpeg");

    expect(res).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("gemini sem GEMINI_API_KEY configurada (ou placeholder) → null sem chamar fetch", async () => {
    const { analisarImagemPeca } = loadAiService({ provider: "gemini" });
    delete process.env.GEMINI_API_KEY;

    const res = await analisarImagemPeca("base64falso", "image/jpeg");

    expect(res).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("gemini: monta a requisição de visão corretamente e devolve a descrição", async () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "motor de partida, aparenta ser de carro de passeio" }] } }],
      }),
    });

    const res = await analisarImagemPeca("base64falso", "image/png");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("chave-gemini-teste");

    const body = JSON.parse(options.body);
    expect(body.contents[0].parts[0].text).toContain("Descreva em UMA frase");
    expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: "image/png", data: "base64falso" });

    expect(res).toBe("motor de partida, aparenta ser de carro de passeio");
  });

  test("anthropic: monta a requisição de visão corretamente (formato Messages API com imagem)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste-123";
    const { analisarImagemPeca } = loadAiService({ provider: "anthropic" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ text: "alternador com um conector danificado" }],
      }),
    });

    const res = await analisarImagemPeca("base64falso", "image/jpeg");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.headers["x-api-key"]).toBe("sk-ant-teste-123");

    const body = JSON.parse(options.body);
    const userMsg = body.messages[0];
    expect(userMsg.content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "base64falso" },
    });
    expect(userMsg.content[1].type).toBe("text");

    expect(res).toBe("alternador com um conector danificado");
  });

  test("resposta EXATA 'NAO_E_PECA' → null (imagem não é peça/veículo)", async () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "NAO_E_PECA" }] } }],
      }),
    });

    const res = await analisarImagemPeca("base64falso", "image/jpeg");
    expect(res).toBeNull();
  });

  test("HTTP de erro → null, não lança exceção", async () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "indisponível",
    });

    const res = await analisarImagemPeca("base64falso", "image/jpeg");
    expect(res).toBeNull();
  });

  test("fetch lança erro de rede → null, não propaga a exceção", async () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "gemini" });

    global.fetch.mockRejectedValueOnce(new Error("network error"));

    const res = await analisarImagemPeca("base64falso", "image/jpeg");
    expect(res).toBeNull();
  });

  test("resposta vazia/em branco → null", async () => {
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "   " }] } }],
      }),
    });

    const res = await analisarImagemPeca("base64falso", "image/jpeg");
    expect(res).toBeNull();
  });

  test("chat em groq + GEMINI_API_KEY configurada: visão chama Gemini mesmo assim (decoupling)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = "chave-gemini-teste";
    const { analisarImagemPeca } = loadAiService({ provider: "groq" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "pastilha de freio dianteira" }] } }],
      }),
    });

    const res = await analisarImagemPeca("base64falso", "image/jpeg");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(res).toBe("pastilha de freio dianteira");
  });
});

/**
 * Pedido do usuário: cliente manda uma NOTA DE VOZ (comum no WhatsApp) falando
 * de veículo/peça, e o bot só respondia "ainda não consigo processar
 * arquivos" — igual acontecia com foto antes da visão (task #144/#156, agora
 * estendido pra áudio). Diferente da visão (que depende do provedor de CHAT
 * ativo suportar imagem), a transcrição usa a API de Whisper da Groq —
 * dedicada e INDEPENDENTE do AI_PROVIDER configurado pro chat: deve funcionar
 * mesmo com AI_PROVIDER=gemini ou anthropic, desde que GROQ_API_KEY exista.
 */
describe("ai.service — suportaAudio()", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test("sem GROQ_API_KEY → false", () => {
    delete process.env.GROQ_API_KEY;
    const { suportaAudio } = loadAiService({ provider: "gemini" });
    expect(suportaAudio()).toBe(false);
  });

  test("GROQ_API_KEY placeholder do .env.example → false", () => {
    process.env.GROQ_API_KEY = "cole_sua_chave_aqui";
    const { suportaAudio } = loadAiService({ provider: "gemini" });
    expect(suportaAudio()).toBe(false);
  });

  test("GROQ_API_KEY configurada → true, independente do AI_PROVIDER de chat ativo", () => {
    process.env.GROQ_API_KEY = "gsk_teste_123";

    expect(loadAiService({ provider: "gemini" }).suportaAudio()).toBe(true);
    expect(loadAiService({ provider: "anthropic" }).suportaAudio()).toBe(true);
    expect(loadAiService({ provider: "groq" }).suportaAudio()).toBe(true);
  });
});

describe("ai.service — transcreverAudio()", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  test("sem GROQ_API_KEY configurada → null sem chamar fetch", async () => {
    delete process.env.GROQ_API_KEY;
    const { transcreverAudio } = loadAiService({ provider: "gemini" });

    const res = await transcreverAudio(Buffer.from("audio-fake"), "audio/ogg");

    expect(res).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("monta a requisição multipart pra API de transcrição da Groq corretamente", async () => {
    process.env.GROQ_API_KEY = "gsk_teste_123";
    const { transcreverAudio } = loadAiService({ provider: "gemini" }); // provedor de CHAT não importa aqui

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ text: "preciso de um motor de partida pro meu fiat uno 2015" }),
    });

    const res = await transcreverAudio(Buffer.from("audio-fake-bytes"), "audio/ogg; codecs=opus");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer gsk_teste_123");

    const form = options.body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("whisper-large-v3-turbo");
    expect(form.get("language")).toBe("pt");
    expect(form.get("response_format")).toBe("json");
    const arquivo = form.get("file");
    expect(arquivo.name).toBe("audio.ogg");
    expect(arquivo.type).toBe("audio/ogg; codecs=opus");

    expect(res).toBe("preciso de um motor de partida pro meu fiat uno 2015");
  });

  test("escolhe a extensão certa a partir do mimetype (m4a/mp3/wav)", async () => {
    process.env.GROQ_API_KEY = "gsk_teste_123";
    const { transcreverAudio } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: "ok" }),
    });

    await transcreverAudio(Buffer.from("x"), "audio/mp4");
    expect(global.fetch.mock.calls[0][1].body.get("file").name).toBe("audio.m4a");

    await transcreverAudio(Buffer.from("x"), "audio/mpeg");
    expect(global.fetch.mock.calls[1][1].body.get("file").name).toBe("audio.mp3");

    await transcreverAudio(Buffer.from("x"), "audio/wav");
    expect(global.fetch.mock.calls[2][1].body.get("file").name).toBe("audio.wav");
  }, 10000); // 3 chamadas em sequência passam pela fila de rate-limit (AUDIO_INTERVAL_MS)

  test("HTTP de erro → null, não lança exceção", async () => {
    process.env.GROQ_API_KEY = "gsk_teste_123";
    const { transcreverAudio } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => "arquivo de áudio inválido",
    });

    const res = await transcreverAudio(Buffer.from("audio-fake"), "audio/ogg");
    expect(res).toBeNull();
  });

  test("fetch lança erro de rede → null, não propaga a exceção", async () => {
    process.env.GROQ_API_KEY = "gsk_teste_123";
    const { transcreverAudio } = loadAiService({ provider: "gemini" });

    global.fetch.mockRejectedValueOnce(new Error("network error"));

    const res = await transcreverAudio(Buffer.from("audio-fake"), "audio/ogg");
    expect(res).toBeNull();
  });

  test("transcrição vazia/em branco (áudio só com ruído/silêncio) → null", async () => {
    process.env.GROQ_API_KEY = "gsk_teste_123";
    const { transcreverAudio } = loadAiService({ provider: "gemini" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ text: "   " }),
    });

    const res = await transcreverAudio(Buffer.from("audio-fake"), "audio/ogg");
    expect(res).toBeNull();
  });
});

/**
 * Catálogo de produtos (src/config/catalogo-produtos.json, extraído pelo
 * usuário do sistema de estoque em 2026-07-20) — confere que o prompt da IA
 * (1) sempre lista as seções reais do catálogo, e (2) confirma pontualmente
 * quando a mensagem do cliente cita o nome exato de uma linha de produto
 * cadastrada, pra IA responder com confiança em vez de "provavelmente".
 */
describe("ai.service — catálogo de produtos no prompt", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  test("prompt sempre inclui as seções reais do catálogo (ex: ALTERNADOR, MOTOR DE PARTIDA)", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: '"resposta":"oi","intencao":"chat"}' }] }),
    });

    await perguntarIA("oi", {});

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.system).toContain("ALTERNADOR");
    expect(body.system).toContain("MOTOR DE PARTIDA");
    expect(body.system).toContain("SEÇÕES REAIS DO CATÁLOGO");
  });

  test("mensagem cita item exato do catálogo (ex: 'regulador de voltagem') → prompt inclui CATÁLOGO CONFIRMA com a seção certa", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: '"resposta":"temos sim","intencao":"vendas"}' }] }),
    });

    await perguntarIA("vocês tem regulador de voltagem pro meu Uno?", {});

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    // Checa o bloco DINÂMICO específico (com "(o cliente citou"), não a
    // substring solta "CATÁLOGO CONFIRMA" — o prompt também menciona essa
    // frase, entre aspas, numa instrução ESTÁTICA sempre presente
    // ("Só com "CATÁLOGO CONFIRMA": confirme só a categoria."), então
    // checar a substring solta dá falso positivo/negativo dependendo do
    // teste. Ver _buildSystemPrompt em ai.service.js.
    expect(body.system).toContain("CATÁLOGO CONFIRMA (o cliente citou");
    expect(body.system).toContain("REGULADOR DE VOLTAGEM");
    expect(body.system).toContain("ALTERNADOR");
  });

  test("mensagem sem item do catálogo → prompt NÃO inclui o bloco dinâmico CATÁLOGO CONFIRMA", async () => {
    const { perguntarIA } = loadAiService({ provider: "anthropic", apiKey: "sk-ant-teste-123" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ text: '"resposta":"bom dia!","intencao":"chat"}' }] }),
    });

    await perguntarIA("bom dia", {});

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    // A instrução estática ("Se aparecer... Só com "CATÁLOGO CONFIRMA":
    // confirme só a categoria.") sempre menciona a frase — o que não deve
    // aparecer é o bloco DINÂMICO com match real do catálogo.
    expect(body.system).not.toContain("CATÁLOGO CONFIRMA (o cliente citou");
  });
});
