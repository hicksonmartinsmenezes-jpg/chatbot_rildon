/**
 * env.js — Validação e tipagem de todas as variáveis de ambiente
 *
 * Deve ser o PRIMEIRO módulo importado em server.js (após dotenv.config).
 * Se alguma variável obrigatória estiver ausente ou inválida, o processo
 * encerra imediatamente com uma mensagem clara — sem subir o servidor
 * em estado inconsistente.
 */

const { z } = require("zod");

// ─── Helpers de validação ─────────────────────────────────────────────────────

const VALORES_PLACEHOLDER = new Set([
  "troque-por-um-token-seguro-aqui",
  "coloque-um-segredo-longo-e-aleatorio-aqui",
  "coloque-uma-senha-forte-aqui",
  "seu-token-aqui",
  "change-me",
  "secret",
  "password",
  "123456"
]);

/** Zod refinement: rejeita strings de placeholder e valores genéricos inseguros */
function naoEhPlaceholder(campo) {
  return z.string().refine(
    val => !VALORES_PLACEHOLDER.has(val.trim().toLowerCase()),
    { message: `${campo}: substitua o valor padrão por um valor real e seguro.` }
  );
}

/** Converte string "true"/"false"/"1"/"0" em booleano */
const boolStr = z
  .string()
  .optional()
  .transform(v => ["true", "1", "yes"].includes((v || "").toLowerCase()));

/** Converte string numérica em inteiro com fallback */
function intStr(defaultVal) {
  return z
    .string()
    .optional()
    .transform(v => {
      const n = parseInt(v ?? "", 10);
      return Number.isNaN(n) ? defaultVal : n;
    });
}

// ─── Schema principal ─────────────────────────────────────────────────────────
const envSchema = z.object({

  // ── Servidor ────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT:     intStr(3000),

  // ── CORS / CSP ──────────────────────────────────────────────────────────────
  CORS_ORIGIN:    z.string().optional().default(""),
  CSP_CONNECT_SRC: z.string().optional().default("'self'"),

  // ── Segurança — obrigatórias, sem placeholder ────────────────────────────────
  API_TOKEN: naoEhPlaceholder("API_TOKEN").min(32, {
    message: "API_TOKEN deve ter pelo menos 32 caracteres. Gere com: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  }),

  // Mantido como opcional para compatibilidade. O sistema atual usa sessão HttpOnly no banco,
  // não JWT. Só exige valor forte se JWT_SECRET for configurado.
  JWT_SECRET: z.string().optional().default("").refine(
    val => !val || (val.length >= 32 && !VALORES_PLACEHOLDER.has(val.trim().toLowerCase())),
    { message: "JWT_SECRET, se usado, deve ter pelo menos 32 caracteres e não pode ser placeholder." }
  ),

  // ── Banco de dados — todas obrigatórias em produção ──────────────────────────
  DB_HOST:     z.string().min(1, { message: "DB_HOST não pode ser vazio." }).default("localhost"),
  DB_PORT:     intStr(5432),
  DB_USER:     z.string().min(1, { message: "DB_USER não pode ser vazio." }),
  DB_PASSWORD: naoEhPlaceholder("DB_PASSWORD").min(6, {
    message: "DB_PASSWORD muito curta. Use uma senha forte."
  }),
  DB_NAME:     z.string().min(1, { message: "DB_NAME não pode ser vazio." }),

  DB_POOL_MAX:                intStr(10),
  DB_POOL_IDLE_TIMEOUT:       intStr(30000),
  DB_POOL_CONNECTION_TIMEOUT: intStr(5000),

  // ── WhatsApp ────────────────────────────────────────────────────────────────
  ATENDENTE_NUMBER: z.string()
    .regex(/^\d{10,15}$/, {
      message: "ATENDENTE_NUMBER deve conter apenas dígitos (10–15), sem + nem espaços. Ex: 5579999999999"
    }),

  // ── Timezone e sessões ───────────────────────────────────────────────────────
  TZ_NEGOCIO:       z.string().default("America/Maceio"),
  AVISO_MINUTOS:    intStr(3),
  TIMEOUT_MINUTOS:  intStr(5),
  SESSION_TTL_HORAS: intStr(24),

  // ── Rate limit do bot ────────────────────────────────────────────────────────
  MAX_CHARS_INPUT:      intStr(500),
  RATE_LIMIT_MAX:       intStr(10),
  RATE_LIMIT_JANELA_MS: intStr(10000),

  // ── Backups ──────────────────────────────────────────────────────────────────
  MAX_BACKUPS: intStr(30),

  // ── Logs ────────────────────────────────────────────────────────────────────
  LOG_LEVEL:      z.enum(["success", "info", "warn", "error"]).default("info"),
  MAX_LOG_SIZE_MB: intStr(10),

  // ── Modo de teste (pedido do usuário, 2026-07-24) ────────────────────────────
  // Números de telefone (só dígitos, sem @s.whatsapp.net/@lid, separados por
  // vírgula) que continuam recebendo resposta normal do bot mesmo com
  // "Bot ativo = Desativado" no painel (Configurações > Funcionamento). Usado
  // pra testar o fluxo em produção sem expor os clientes reais enquanto o bot
  // está desligado. Ver resolverBotOffEfetivo() em botConfig.service.js — a
  // tag "Funcionário" do contato tem prioridade sobre este bypass.
  // Ex no .env: TEST_NUMBERS=5579999999999,5579888888888
  //
  // NOTA: config/whatsapp.js (onde essa lista é de fato consultada) lê
  // process.env.TEST_NUMBERS diretamente, com o MESMO parsing abaixo,
  // em vez de importar este módulo — evita acoplar esse arquivo (importado
  // isoladamente pelos testes de whatsapp.*) à validação completa de env.js,
  // que derruba o processo se qualquer variável obrigatória (API_TOKEN,
  // DB_PASSWORD etc.) estiver faltando. Declarado aqui mesmo assim, pra
  // seguir o padrão do projeto de documentar toda variável de ambiente num
  // só lugar. Se mudar o formato/separador, mude nos dois lugares.
  TEST_NUMBERS: z
    .string()
    .optional()
    .default("")
    .transform(v =>
      v
        .split(",")
        .map(n => n.replace(/\D/g, ""))
        .filter(Boolean)
    ),
});

// ─── Executa a validação ──────────────────────────────────────────────────────
function validarEnv() {
  const resultado = envSchema.safeParse(process.env);

  if (!resultado.success) {
    const erros = resultado.error.issues ?? resultado.error.errors ?? [];

    console.error("\n╔══════════════════════════════════════════════════════════╗");
    console.error("║     ❌  ERRO DE CONFIGURAÇÃO — servidor não iniciado     ║");
    console.error("╠══════════════════════════════════════════════════════════╣");

    erros.forEach(err => {
      const campo = err.path.join(".") || "desconhecido";
      console.error(`║  • [${campo}] ${err.message}`);
    });

    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║  Corrija o arquivo .env e reinicie o servidor.           ║");
    console.error("╚══════════════════════════════════════════════════════════╝\n");

    process.exit(1);
  }

  // Injeta os valores já tipados de volta no process.env e exporta
  return resultado.data;
}

const env = validarEnv();

module.exports = env;
