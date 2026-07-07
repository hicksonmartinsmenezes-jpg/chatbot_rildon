/**
 * Cria o primeiro usuário administrador diretamente no banco.
 *
 * Necessário porque /api/users exige um admin já logado para criar
 * qualquer usuário (galinha e ovo no primeiro acesso). Rode uma vez após
 * `psql -f src/database/schema.sql` e antes do primeiro login no painel.
 *
 * Uso:
 *   node scripts/create-admin.js <usuario> <senha> ["Nome completo"]
 *
 * Exemplo:
 *   node scripts/create-admin.js admin "MinhaSenh@Forte123" "Administrador"
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const bcrypt = require("bcrypt");
const pool = require("../src/database/postgres");

const SALT_ROUNDS = 10;

async function main() {
  const [, , usuario, senha, nome] = process.argv;

  if (!usuario || !senha) {
    console.error("Uso: node scripts/create-admin.js <usuario> <senha> [\"Nome completo\"]");
    process.exit(1);
  }

  if (senha.length < 8) {
    console.error("A senha deve ter pelo menos 8 caracteres.");
    process.exit(1);
  }

  const existing = await pool.query(
    "SELECT id FROM users WHERE usuario = $1 LIMIT 1",
    [usuario]
  );

  if (existing.rows.length > 0) {
    console.error(`Usuário "${usuario}" já existe. Use src/database/migrate.js/reset de senha ou escolha outro nome.`);
    process.exit(1);
  }

  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

  const result = await pool.query(
    `INSERT INTO users (nome, usuario, senha, perfil, sector, ativo)
     VALUES ($1, $2, $3, 'admin', 'geral', TRUE)
     RETURNING id, nome, usuario, perfil`,
    [nome || usuario, usuario, senhaHash]
  );

  console.log("Administrador criado com sucesso:");
  console.log(result.rows[0]);
  process.exit(0);
}

main().catch(err => {
  console.error("Falha ao criar administrador:", err.message);
  process.exit(1);
});
