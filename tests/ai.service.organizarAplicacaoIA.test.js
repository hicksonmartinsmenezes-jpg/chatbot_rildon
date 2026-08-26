/**
 * Testes de ai.service.js#organizarAplicacaoIA (Issue #23, 2026-08-26) —
 * reorganiza um texto cru de "aplicação" (veículo/máquina compatível) com
 * IA. Mesmo padrão de mock de ai.service.test.js (fetch mockado, módulo
 * recarregado por teste pra reler AI_PROVIDER do env).
 */

const ORIGINAL_ENV = { ...process.env };

function loadAiService({ provider, apiKey } = {}) {
  jest.resetModules();
  if (provider !== undefined) process.env.AI_PROVIDER = provider;
  if (apiKey !== undefined) process.env.GROQ_API_KEY = apiKey;
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

  test("texto vazio/nulo → null sem chamar fetch", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    expect(await organizarAplicacaoIA("")).toBeNull();
    expect(await organizarAplicacaoIA(null)).toBeNull();
    expect(await organizarAplicacaoIA("   ")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("sem GROQ_API_KEY configurada → null sem chamar fetch", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "" });

    const res = await organizarAplicacaoIA("Escort, Uno, Duna, MWM, Universal, Ford, MB");

    expect(res).toBeNull();
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

  test("erro HTTP genérico (500) → null, sem lançar", async () => {
    const { organizarAplicacaoIA } = loadAiService({ provider: "groq", apiKey: "chave-teste" });

    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "erro interno",
    });

    const res = await organizarAplicacaoIA("Escort, Ford");
    expect(res).toBeNull();
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
