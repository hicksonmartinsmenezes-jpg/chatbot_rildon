const { humanizarErro, formatarAlerta } = require('../scripts/x2-whatsapp-alerta');

describe('humanizarErro', () => {
  test('traduz timeout de locator e remove códigos de cor/call log', () => {
    const bruto = 'locator.click: Timeout 10000ms exceeded.\nCall log:\n[2m  - waiting for locator(\'a:has-text("Logística")\').first()[22m';
    const out = humanizarErro(bruto);
    expect(out).toContain('"Logística"');
    expect(out).not.toMatch(/\[2m|Call log|locator\./);
  });
  test('janela fechada e rede', () => {
    expect(humanizarErro('page.goto: Target closed')).toMatch(/Chrome/);
    expect(humanizarErro('page.goto: net::ERR_NAME_NOT_RESOLVED at x')).toMatch(/conexão/);
  });
  test('limita o tamanho', () => {
    expect(humanizarErro('x'.repeat(500)).length).toBeLessThanOrEqual(220);
  });
});

describe('formatarAlerta', () => {
  test('uma linha vira parágrafo, capitalizada; várias viram lista', () => {
    expect(formatarAlerta({ titulo: 'T', linhas: ['o estoque parou'] })).toContain('\n\nO estoque parou\n\n');
    expect(formatarAlerta({ titulo: 'T', linhas: ['a', 'b'] })).toContain('• A\n• B');
  });
});
