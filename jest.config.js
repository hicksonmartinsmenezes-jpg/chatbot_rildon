/** Configuração do Jest — testes de unidade do backend. */
module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  clearMocks: true,
  // Evita que logs poluam a saída dos testes
  silent: false
};
