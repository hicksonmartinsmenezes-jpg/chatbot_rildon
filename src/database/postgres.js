/**
 * Pool de conexões PostgreSQL.
 * Configuração via variáveis de ambiente (.env).
 */
const { Pool } = require("pg");
const logger   = require("../utils/logger");

const pool = new Pool({
  host:     process.env.DB_HOST     || "localhost",
  port:     Number(process.env.DB_PORT) || 5432,
  user:     process.env.DB_USER     || "postgres",
  // Garantir string — DB_PASSWORD undefined causa erro SASL no driver pg
  password: String(process.env.DB_PASSWORD || ""),
  database: process.env.DB_NAME     || "chatbot_rildon",
  max:      Number(process.env.DB_POOL_MAX)                || 20,
  idleTimeoutMillis:       Number(process.env.DB_POOL_IDLE_TIMEOUT)        || 30000,
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT)  || 15000,
  // MELHORIA: suporte a SSL para conexões em produção (ex: Heroku, Railway, Render)
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});

pool.on("error", (err) => {
  logger.error(`[PostgreSQL] Erro inesperado no pool: ${err.message}`);
});

/**
 * Verifica conexão com o banco na inicialização.
 * Lança erro se não conseguir conectar — impede o servidor de subir sem banco.
 */
async function verificarConexao() {
  const client = await pool.connect();
  try {
    const res = await client.query("SELECT NOW() AS agora");
    logger.info(`[PostgreSQL] ✓ Conectado — servidor: ${res.rows[0].agora}`);
  } finally {
    client.release();
  }
}

/**
 * MELHORIA: cria a tabela de deduplicação caso não exista.
 * Chamado uma vez na inicialização (server.js).
 * Mantém apenas mensagens das últimas 24h para não crescer indefinidamente.
 */
async function garantirTabelaDedup() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id   TEXT        PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Índice para limpeza periódica eficiente
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_processed_messages_at
        ON processed_messages (processed_at)
    `);

    // Tabela de contatos (migration 009)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nome         VARCHAR(255) NOT NULL,
        whatsapp     VARCHAR(30)  NOT NULL,
        estado       VARCHAR(2),
        status       VARCHAR(20)  NOT NULL DEFAULT 'ativo',
        tags         TEXT[]       NOT NULL DEFAULT '{}',
        atendente_id UUID REFERENCES users(id) ON DELETE SET NULL,
        departamento VARCHAR(100),
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp ON contacts(whatsapp)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_status   ON contacts(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_contacts_nome     ON contacts(lower(nome))`);

    // Tabela de auditoria
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id         SERIAL PRIMARY KEY,
        user_id    TEXT,
        user_name  TEXT,
        user_role  TEXT,
        action     TEXT NOT NULL,
        target     TEXT,
        details    JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC)`);

    // Mapa @lid → JID real (persistido para sobreviver a restarts e garantir entrega)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lid_map (
        lid        TEXT PRIMARY KEY,
        jid        TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Índices para queries do dashboard (status, data, setor)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets (created_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets (user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status_created ON tickets (status, created_at)`);

    logger.info("[PostgreSQL] Tabelas e índices prontos.");
  } catch (err) {
    logger.warn(`[PostgreSQL] Não foi possível criar tabela/índices: ${err.message}`);
  }
}

/**
 * Remove entradas de deduplicação com mais de 24h.
 * Chamado periodicamente em server.js para evitar crescimento da tabela.
 */
async function limparMensagensProcessadas() {
  try {
    const res = await pool.query(
      `DELETE FROM processed_messages WHERE processed_at < NOW() - INTERVAL '24 hours'`
    );
    if (res.rowCount > 0) {
      logger.info(`[Dedup] ${res.rowCount} entrada(s) antigas removidas.`);
    }
  } catch (err) {
    logger.warn(`[Dedup] Erro na limpeza: ${err.message}`);
  }
}

module.exports = pool;
module.exports.verificarConexao          = verificarConexao;
module.exports.garantirTabelaDedup       = garantirTabelaDedup;
module.exports.limparMensagensProcessadas = limparMensagensProcessadas;
