/**
 * Runner de migrations sequencial.
 * Uso: node src/database/migrate.js
 *
 * Executa todos os arquivos .sql em src/database/migrations/ em ordem
 * alfabética, rastreando quais já foram aplicados na tabela migrations_log.
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const fs   = require("fs");
const pool = require("./postgres");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function run() {
  const client = await pool.connect();

  try {
    // Garante tabela de controle
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id         SERIAL PRIMARY KEY,
        filename   TEXT UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Lista arquivos .sql em ordem
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM migrations_log WHERE filename = $1",
        [file]
      );

      if (rows.length > 0) {
        console.log(`  ⏭  Já aplicada: ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO migrations_log (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  ✅ Aplicada: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ❌ Falha em ${file}: ${err.message}`);
        process.exit(1);
      }
    }

    console.log("\nMigrations concluídas.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("Erro no runner:", err.message);
  process.exit(1);
});
