const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const logger     = require("./utils/logger");

const pool              = require("./database/postgres");
const quickReplyRoutes  = require("./routes/quickReply.routes");
const userRoutes        = require("./routes/user.routes");
const activityLogRoutes = require("./routes/activityLog.routes");
const metricsRoutes     = require("./routes/metrics.routes");
const broadcastRoutes = require("./routes/broadcast.routes");

const {
  router: authRouter,
  authSession,
  requireAdmin
} = require("./routes/auth.routes");

const ticketRoutes   = require("./routes/ticket.routes");
const historyRoutes  = require("./routes/history.routes");
const messageRoutes  = require("./routes/message.routes");
const contactRoutes  = require("./routes/contact.routes");
const settingsRoutes = require("./routes/settings.routes");

const app = express();

// ── Segurança: Helmet com CSP configurada ────────────────────────────────────
// MELHORIA: CSP habilitada com origens configuráveis via .env (antes estava desabilitada)
const cspConnectSrc = (process.env.CSP_CONNECT_SRC || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],

      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://cdn.jsdelivr.net"
      ],

      scriptSrcAttr: [
        "'unsafe-inline'"
      ],

      styleSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdn.jsdelivr.net"
      ],

      styleSrcElem: [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com",
        "https://cdn.jsdelivr.net"
      ],

      fontSrc: [
        "'self'",
        "data:",
        "https://fonts.gstatic.com",
        "https://cdn.jsdelivr.net"
      ],

      imgSrc: [
        "'self'",
        "data:",
        "blob:"
      ],

      connectSrc: [
        "'self'",
        "ws:",
        "wss:"
      ],

      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// MELHORIA: CORS restrito à origem configurada via .env (antes: aberto para qualquer origem)
const corsOptions = {
  origin: (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean),
  credentials: true
};
// Se CORS_ORIGIN não foi definido, permite apenas same-origin (sem header CORS)
app.use(corsOptions.origin.length > 0 ? cors(corsOptions) : cors({ origin: false }));

app.use(express.json({ limit: "2mb" }));

// ── Rate Limit da API ─────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: "Muitas requisições. Aguarde alguns instantes." },
  standardHeaders: true,
  legacyHeaders:   false
});

app.use("/api", apiLimiter);
app.use(logger.httpLogger);

// ── Arquivos estáticos do painel ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../frontend")));

// ── Rotas ─────────────────────────────────────────────────────────────────────
app.use("/api", authRouter);

// Rotas autenticadas
app.use("/api", authSession, contactRoutes);

// Rotas autenticadas
app.use("/api", authSession, ticketRoutes);
app.use("/api", authSession, historyRoutes);
app.use("/api", authSession, messageRoutes);

// Rotas apenas admin
app.use("/api", authSession, requireAdmin, settingsRoutes);
app.use("/api", authSession, requireAdmin, quickReplyRoutes);
app.use("/api", authSession, requireAdmin, userRoutes);
app.use("/api", authSession, requireAdmin, activityLogRoutes);
app.use("/api", authSession, requireAdmin, metricsRoutes);
app.use("/api", authSession, requireAdmin, broadcastRoutes);

// Health check — verifica banco também para balanceadores e orquestradores
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: false, error: err.message });
  }
});

// Upload de fotos de perfil
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ── Global error handler ──────────────────────────────────────────────────────
// MELHORIA: captura erros não tratados em rotas async e retorna JSON padronizado
// em vez de HTML 500 ou silêncio
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error(`[Express] ${req.method} ${req.path} — ${err.message}`);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Erro interno do servidor." });
});

module.exports = app;
