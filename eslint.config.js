const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

/**
 * ESLint (flat config). Foco no backend (CommonJS) e nos testes.
 * O frontend é script global (funções compartilhadas entre arquivos via window),
 * então `no-undef` daria muito ruído — fica para uma etapa posterior.
 *
 * Filosofia: regras de BUG real como "error" (recommended); estilo/uso como
 * "warn" para não travar o CI em código legado — os avisos guiam a limpeza
 * gradual sem bloquear.
 */
module.exports = [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "build/**",
      "frontend/**",
      "src/uploads/**",
      "src/logs/**"
    ]
  },

  // Backend
  {
    files: ["src/**/*.js", "*.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["warn", { allowEmptyCatch: true }]
    }
  },

  // Testes (globals do Jest)
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.jest }
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "warn"
    }
  },

  // Desliga regras de estilo que conflitam com o Prettier
  prettier
];
