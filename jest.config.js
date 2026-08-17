/** Configuração do Jest — testes de unidade do backend. */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  clearMocks: true,
  // Evita que logs poluam a saída dos testes
  silent: false,

  // Coverage: medido a partir de agora (rodar "npm run test:coverage").
  // Ainda sem coverageThreshold — a CI nunca rodou os testes com sucesso
  // até esta mudança (faltava Postgres no workflow), então não existe
  // baseline real pra travar um número sem chutar. Depois do 1º run verde
  // em CI, captura o coverage-summary.json real e define o threshold como
  // "não regredir abaixo disso", não um alvo arbitrário.
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/database/migrate.js",
    "!src/database/test-postgres.js"
  ],
  coverageReporters: ["text-summary", "json-summary", "lcov"]
};
