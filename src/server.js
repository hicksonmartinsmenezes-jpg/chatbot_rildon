const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Limita o flood de "Bad MAC"/"Session error" do libsignal (travava o painel).
require("./utils/signal-log-guard").instalar();

// ── Validação de variáveis de ambiente ───────────────────────────────────────
// DEVE ser importado logo após o dotenv — aborta o processo se faltar algo crítico
const env = require("./config/env");

// ── Monitoramento de erros — inicializado antes do Express (app) ──────────────
const sentry = require("./config/sentry");
sentry.initSentry();

const fs     = require("fs");
const logger = require("./utils/logger");
const app    = require("./app");

const {
  verificarConexao,
  garantirTabelaDedup,
  limparMensagensProcessadas
} = require("./database/postgres");

const { carregarEstoque }      = require("./services/estoque.service");
const { startAutoBackup }      = require("./services/backup.service");
const { startScheduler: startCampaignScheduler } = require("./services/campaign-schedule.service");
const { carregar: carregarHumanMode } = require("./services/humanMode.service");
const { connectWhatsApp, sendMessage } = require("./config/whatsapp");
const { processMessage }       = require("./services/message.service");
const { setSendMessage }       = require("./services/session.service");
const { setNotifySendMessage } = require("./services/notificacao.service");

const PORT = env.PORT;

// Garante que o diretório de dados existe
// CORRIGIDO: caminho era '../src/data' — quando __dirname = src/, resolvia errado
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

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

    // 2b. Restaura sessões de atendimento humano (bot pausado) do banco
    await carregarHumanMode();

    // 3. MELHORIA: agendar limpeza periódica da tabela de deduplicação (a cada 6h)
    setInterval(limparMensagensProcessadas, 6 * 60 * 60 * 1000);

    // 3b. Cache de estoque do Catálogo X2 (pedido do usuário, 2026-08-07) —
    // carrega uma vez no boot e recarrega a cada 30min (o CSV em si só é
    // atualizado 1x/dia via Rotina, 30min é sobra de margem). Não bloqueia
    // o boot em caso de falha (tabela pode não existir ainda — ver
    // estoque.service.js).
    await carregarEstoque();
    setInterval(carregarEstoque, 30 * 60 * 1000);

    // 4. Iniciar backup automático
    startAutoBackup();

    // 4b. Agendador de campanhas (agendamento único/recorrente do Campanhas)
    startCampaignScheduler();

    // 5. Subir servidor HTTP
    await new Promise((resolve) => {
      server.listen(PORT, "0.0.0.0", () => {
        logger.info(`✓ Servidor rodando na porta ${PORT}`);
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

process.on("unhandledRejection", (err) => {
  logger.error(
    `Unhandled Rejection: ${err?.stack || err}`
  );
  sentry.captureException(err instanceof Error ? err : new Error(String(err)));
});

process.on("uncaughtException", async (err) => {
  logger.error(
    `Uncaught Exception: ${err?.stack || err}`
  );

  sentry.captureException(err);
  await sentry.flush(2000); // garante o envio antes de encerrar
  process.exit(1);
});

function gracefulShutdown(signal) {
  logger.warn(`${signal} recebido. Encerrando servidor...`);

  const forceExit = setTimeout(() => {
    logger.error("Forçando encerramento após timeout.");
    process.exit(1);
  }, 10000);

  server.close(() => {
    clearTimeout(forceExit);
    logger.info("Servidor HTTP encerrado com segurança.");
    process.exit(0);
  });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
