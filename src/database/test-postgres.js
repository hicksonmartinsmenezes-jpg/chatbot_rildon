require("dotenv").config();

const pool = require("./postgres");

async function testConnection() {
  try {

    const result =
      await pool.query("SELECT NOW()");

    console.log(
      "✅ PostgreSQL conectado!"
    );

    console.log(result.rows[0]);

    process.exit(0);

  } catch (error) {

    console.error(
      "❌ Erro PostgreSQL:"
    );

    console.error(error.message);

    process.exit(1);
  }
}

testConnection();