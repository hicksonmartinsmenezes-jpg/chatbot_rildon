const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const fs     = require("fs");
const logger = require("./utils/logger");
const app    = require("./app");

const {
  verificarConexao,
  garantirTabelaDedup,
  limparMensagensProcessadas
} = require("./database/postgres");

const { startAutoBackup }      = require("./services/backup.service");
const { connectWhatsApp, sendMessage } = require("./config/whatsapp");
const { processMessage }       = require("./services/message.service");
const { setSendMessage }       = require("./services/session.service");
const { setNotifySendMessage } = require("./services/notificacao.service");

const PORT = process.env.PORT || 3000;

// Garante que o diretório de dados existe
const dataDir = path.join(__dirname, "../src/data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Avisos de configuração ────────────────────────────────────────────────────
if (!process.env.API_TOKEN || process.env.API_TOKEN === "troque-por-um-token-seguro-aqui") {
  logger.warn("⚠️  API_TOKEN não configurado. Configure antes de expor em produção!");
}

if (!process.env.DB_PASSWORD) {
  logger.warn("⚠️  DB_PASSWORD não definida. Verifique o arquivo .env.");
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "coloque-um-segredo-longo-e-aleatorio-aqui") {
  logger.warn("⚠️  JWT_SECRET não configurado com valor seguro!");
}

// ── Servidor HTTP + Socket.io ─────────────────────────────────────────────────
const http           = require("http");
const { initSocket } = require("./services/socket.service");
const server         = http.createServer(app);

initSocket(server);

// ── Inicialização sequencial ──────────────────────────────────────────────────
(async () => {
  try {
    // 1. Verificar banco antes de tudo
    await verificarConexao();

    // 2. MELHORIA: criar tabela de deduplicação se não existir
    await garantirTabelaDedup();

    // 3. MELHORIA: agendar limpeza periódica da tabela de deduplicação (a cada 6h)
    setInterval(limparMensagensProcessadas, 6 * 60 * 60 * 1000);

    // 4. Iniciar backup automático
    startAutoBackup();

    // 5. Subir servidor HTTP
    await new Promise((resolve) => {
      server.listen(PORT, "0.0.0.0", () => {
        logger.success(`Servidor rodando na porta ${PORT}`);
        logger.info(`Painel: http://localhost:${PORT}`);
        logger.info(`Tickets: http://localhost:${PORT}/api/tickets`);
        resolve();
      });
    });

    // 6. Conectar WhatsApp
    logger.info("Iniciando conexão com WhatsApp...");
    await connectWhatsApp(processMessage);
    setSendMessage(sendMessage);
    setNotifySendMessage(sendMessage);

  } catch (err) {
    logger.error(`Falha na inicialização: ${err.message}`);
    process.exit(1);
  }
})();
