/**
 * Testes de ai.service.js#organizarAplicacaoIA (Issue #23, 2026-08-26) —
 * reorganiza um texto cru de "aplicação" (veículo/máquina compatível) com
 * IA. Mesmo padrão de mock de ai.service.test.js (fetch mockado, módulo
 * recarregado por teste pra reler AI_PROVIDER do env).
 */

const ORIGINAL_ENV = { ...process.env };

function loadAiService({ provider, apiKey, geminiKey } = {}) {
  jest.resetModules();
  if (provider !== undefined) process.env.AI_PROVIDER = provider;
  if (apiKey !== undefined) process.env.GROQ_API_KEY = apiKey;
  if (geminiKey !== undefined) process.env.GEMINI_API_KEY = geminiKey;
  return require("../src/services/ai.service");
}

describe("ai.service — organizarAplicacaoIA", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    global.fetch = originalFetch;
  });

  // undefined (não null) de propósito nesses 3 casos abaixo — "não tentou
  // de verdade" precisa ficar RETRYABLE, não virar falha permanente no
  // cache de quem chama (ver catalogo-aplicacao-ia.service.js e o bug real
  // de 2026-08-29 documentado no comentário de organizarAplicacaoIA).
  test("texto vazio/nulo → undefined sem chamar fetch (retryable, não é falha permanente)", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    expect(await organizarAplicacaoIA("")).toBeUndefined();
    expect(await organizarAplicacaoIA(null)).toBeUndefined();
    expect(await organizarAplicacaoIA("   ")).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("sem GROQ_API_KEY configurada → undefined sem chamar fetch (retryable)", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "" });

    const res = await organizarAplicacaoIA("Escort, Uno, Duna, MWM, Universal, Ford, MB");

    expect(res).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("chamada bem-sucedida (groq) → retorna texto reorganizado, SEM response_format json_object", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "FORD: Escort; VW: Uno, Duna; MWM: diversos; MB: diversos" } }],
      }),
    });

    const res = await organizarAplicacaoIA("Escort, Uno, Duna, MWM, Universal, Ford, MB");

    expect(res).toBe("FORD: Escort; VW: Uno, Duna; MWM: diversos; MB: diversos");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain("groq.com");
    const body = JSON.parse(options.body);
    // Diferente do chat (perguntarIA), essa chamada é texto livre — não
    // pode forçar response_format json_object (o prompt pede texto puro).
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: "Escort, Uno, Duna, MWM, Universal, Ford, MB" });
  });

  test("resposta vem entre aspas → aspas removidas", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '"FORD: Escort"' } }] }),
    });

    const res = await organizarAplicacaoIA("Escort, Ford");
    expect(res).toBe("FORD: Escort");
  });

  test("erro HTTP genérico (500) → undefined (retryable), sem lançar", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "erro interno",
    });

    const res = await organizarAplicacaoIA("Escort, Ford");
    expect(res).toBeUndefined();
  });

  test("sem crédito na API (Anthropic) e SEM Gemini configurado → undefined (retryable) + ativa circuit breaker", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
    const { organizarAplicacaoIA } = loadAiService({ provider: "anthropic", geminiKey: "" });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } }),
    });

    const res = await organizarAplicacaoIA("Escort, Ford");
    // undefined — NÃO pode virar "" permanente no cache de quem chama, ou
    // fica marcado como "sem aplicação" pra sempre mesmo depois de
    // recarregar crédito (bug real de 2026-08-29).
    expect(res).toBeUndefined();

    // Circuit breaker ativo: 2ª chamada nem tenta a rede.
    global.fetch.mockClear();
    const res2 = await organizarAplicacaoIA("Outro texto");
    expect(res2).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Fallback automático (pedido do usuário, 2026-08-29): sem crédito na
  // Anthropic + Gemini configurado → troca sozinho, SÓ nesta função (não
  // mexe no provedor do chat ao vivo — ver perguntarIA, que lê PROVIDER/
  // PROVIDER_NAME diretamente e nunca _aplicacaoProviderOverride, então é
  // estruturalmente impossível essa troca vazar pro chat).
  test("sem crédito na Anthropic + Gemini configurado → troca sozinho pra Gemini e retorna o resultado", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
    const { organizarAplicacaoIA } = loadAiService({ provider: "anthropic", geminiKey: "gemini-chave-teste" });

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "FORD: Escort" }] } }] }),
      });

    const res = await organizarAplicacaoIA("Escort, Ford");

    expect(res).toBe("FORD: Escort");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toContain("anthropic.com");
    expect(global.fetch.mock.calls[1][0]).toContain("generativelanguage.googleapis.com");
  });

  test("fallback pra Gemini fica ativo pro PRÓXIMO texto também (não tenta Anthropic de novo)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
    const { organizarAplicacaoIA } = loadAiService({ provider: "anthropic", geminiKey: "gemini-chave-teste" });

    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: "Your credit balance is too low to access the Anthropic API." } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: "FORD: Escort" }] } }] }),
      });
    await organizarAplicacaoIA("Escort, Ford"); // dispara o fallback

    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "VW: Gol" }] } }] }),
    });
    const res = await organizarAplicacaoIA("Gol, VW");

    // 1 chamada só (direto no Gemini) — não tentou Anthropic de novo.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain("generativelanguage.googleapis.com");
    expect(res).toBe("VW: Gol");
  });

  test("erro de rede/timeout (fetch lança) → undefined (retryable), sem lançar", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    global.fetch.mockRejectedValueOnce(new Error("fetch failed"));

    const res = await organizarAplicacaoIA("Escort, Ford");
    expect(res).toBeUndefined();
  });

  test("provedor anthropic → NÃO usa o truque de prefill '{' do chat (resposta é texto puro)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-teste";
    const { organizarAplicacaoIA } = loadAiService({ provider: "anthropic" });

    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ text: "FORD: Escort" }] }),
    });

    const res = await organizarAplicacaoIA("Escort, Ford");

    // Se a função reusasse por engano _extrairTextoResposta (que recompõe
    // "{" pro prefill do chat), o resultado viria corrompido como "{FORD:
    // Escort" — confirma que a extração é a nativa, sem prefill.
    expect(res).toBe("FORD: Escort");

    const [, options] = global.fetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.messages[body.messages.length - 1]).not.toEqual({ role: "assistant", content: "{" });
  });
});
