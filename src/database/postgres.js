/**
 * Pool de conexões PostgreSQL com configuração via .env e
 * verificação de conectividade na inicialização.
 */
const { Pool } = require("pg");
const logger   = require("../utils/logger");

const pool = new Pool({
  host:               process.env.DB_HOST     || "localhost",
  port:               Number(process.env.DB_PORT) || 5432,
  user:               process.env.DB_USER     || "postgres",
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME     || "chatbot_rildon",
  max:                Number(process.env.DB_POOL_MAX)                || 10,
  idleTimeoutMillis:  Number(process.env.DB_POOL_IDLE_TIMEOUT)       || 30000,
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT) || 5000,
});

pool.on("error", (err) => {
  logger.error(`[PostgreSQL] Erro inesperado no pool: ${err.message}`);
});

/**
 * Verifica conexão com o banco na inicialização.
 * Lança erro se não conseguir conectar (impede o servidor de subir sem banco).
 */
async function verificarConexao() {
  try {
    const client = await pool.connect();
    const res    = await client.query("SELECT NOW() AS agora");
    client.release();
    logger.success(`[PostgreSQL] Conectado — servidor: ${res.rows[0].agora}`);
  } catch (err) {
    logger.error(`[PostgreSQL] Falha ao conectar: ${err.message}`);
    logger.error("[PostgreSQL] Verifique DB_HOST, DB_USER, DB_PASSWORD e DB_NAME no .env");
    throw err;
  }
}

module.exports = pool;
module.exports.verificarConexao = verificarConexao;
