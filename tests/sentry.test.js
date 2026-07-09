/**
 * Testes do wrapper de monitoramento (Sentry).
 * O ponto crítico: sem SENTRY_DSN, tudo deve ser no-op seguro — o monitoramento
 * NUNCA pode derrubar a aplicação nem exigir configuração para rodar em dev.
 */
const ORIGINAL_DSN = process.env.SENTRY_DSN;

afterEach(() => {
  jest.resetModules();
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
});

describe("config/sentry — sem DSN (desativado)", () => {
  test("initSentry não ativa e captureException/flush não lançam", async () => {
    delete process.env.SENTRY_DSN;
    const sentry = require("../src/config/sentry");

    sentry.initSentry();
    expect(sentry.isEnabled()).toBe(false);

    // No-ops seguros — não devem lançar mesmo desativados
    expect(() => sentry.captureException(new Error("teste"))).not.toThrow();
    await expect(sentry.flush(100)).resolves.toBeUndefined();
  });

  test("captureException tolera valores não-Error sem quebrar", () => {
    delete process.env.SENTRY_DSN;
    const sentry = require("../src/config/sentry");
    sentry.initSentry();

    expect(() => sentry.captureException("string solta")).not.toThrow();
    expect(() => sentry.captureException(null)).not.toThrow();
  });
});
