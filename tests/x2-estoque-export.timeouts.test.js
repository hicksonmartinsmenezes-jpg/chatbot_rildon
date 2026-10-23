// Regressão do bug achado na varredura de 2026-10-23: a espera do download do CSV
// (90s) era menor que o tempo máximo do clique em "Exportar em CSV" (3 tentativas de
// 60s = 180s), então execuções boas morriam com "Timeout ... waiting for event download".
// Este teste trava a invariante para que subir um dos tempos sem subir o outro quebre aqui.
const exportador = require("../scripts/x2-estoque-export");

describe("tempos do export de estoque", () => {
  const { TIMEOUT_CLIQUE_CSV_MS, TENTATIVAS_CLIQUE_CSV, TIMEOUT_DOWNLOAD_MS } = exportador;

  test("a espera do download cobre o pior caso do clique", () => {
    const piorCasoDoClique = TENTATIVAS_CLIQUE_CSV * TIMEOUT_CLIQUE_CSV_MS;
    expect(TIMEOUT_DOWNLOAD_MS).toBeGreaterThan(piorCasoDoClique);
  });

  test("ainda sobra folga para o X2 gerar o arquivo", () => {
    const folga = TIMEOUT_DOWNLOAD_MS - TENTATIVAS_CLIQUE_CSV * TIMEOUT_CLIQUE_CSV_MS;
    expect(folga).toBeGreaterThanOrEqual(30000);
  });
});
