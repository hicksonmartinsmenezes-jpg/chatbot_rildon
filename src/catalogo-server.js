// Servidor do CATÁLOGO em processo próprio (contêiner "catalogo", porta 3001).
// O painel de atendimento continua em src/server.js — este aqui não toca no WhatsApp.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
process.env.CATALOGO_PROCESSO = "catalogo";

require("./utils/signal-log-guard").instalar();
require("./config/env");

const logger = require("./utils/logger");
const http = require("http");
const app = require("./catalogo-app");
const { verificarConexao } = require("./database/postgres");
const { carregarEstoque } = require("./services/estoque.service");

const PORT = Number(process.env.CATALOGO_PORT || 3001);
const server = http.createServer(app);

(async () => {
  try {
    await verificarConexao();
    await carregarEstoque();
    setInterval(carregarEstoque, 30 * 60 * 1000);

    // PDFs prontos: refaz tudo só nas segundas-feiras às 20h (ver catalogo-prontos.service.js).
    require("./services/catalogo-prontos.service").iniciar({ horaRefazer: 20 });

    await new Promise((resolve) => server.listen(PORT, "0.0.0.0", resolve));
    logger.info(`✓ Servidor do catálogo rodando na porta ${PORT}`);

    // Fotos repetidas (2026-10-23): mapeia em segundo plano, depois que o
    // servidor já está atendendo, quais produtos têm a mesma foto duas vezes
    // — sem isso a busca só saberia disso no primeiro produto que alguém
    // abrisse, e o card nasceria com a peça repetida. Cede o event loop o
    // tempo todo (ver aquecerDuplicadas), então não atrasa consulta nenhuma.
    setTimeout(() => {
      require("./services/catalogo-fotos.service").aquecerDuplicadas()
        .catch((e) => logger.error(`Falha ao mapear fotos repetidas: ${e.message}`));
    }, 20 * 1000);
  } catch (err) {
    logger.error(`Falha na inicialização do catálogo: ${err.message}`);
    process.exit(1);
  }
})();

process.on("unhandledRejection", (err) => logger.error(`Unhandled Rejection: ${err?.stack || err}`));
process.on("uncaughtException", (err) => { logger.error(`Uncaught Exception: ${err?.stack || err}`); process.exit(1); });

function encerrar(sinal) {
  logger.warn(`${sinal} recebido. Encerrando catálogo...`);
  const f = setTimeout(() => process.exit(1), 10000);
  server.close(() => { clearTimeout(f); process.exit(0); });
}
process.on("SIGINT", () => encerrar("SIGINT"));
process.on("SIGTERM", () => encerrar("SIGTERM"));
