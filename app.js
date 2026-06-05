const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const fs        = require("fs");
const helmet    = require("helmet");
const rateLimit = require("express-rate-limit");
const logger    = require("./utils/logger");

const pool              = require("./database/postgres");
const quickReplyRoutes  = require("./routes/quickReply.routes");
const userRoutes        = require("./routes/user.routes");
const activityLogRoutes = require("./routes/activityLog.routes");
const metricsRoutes     = require("./routes/metrics.routes");
const broadcastRoutes   = require("./routes/broadcast.routes");

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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      styleSrcElem:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      fontSrc:        ["'self'", "data:", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
      imgSrc:         ["'self'", "data:", "blob:"],
      connectSrc:     ["'self'", "ws:", "wss:"],
      objectSrc:      ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ── CORS configurável via .env ────────────────────────────────────────────────
const corsOrigins = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
app.use(corsOrigins.length > 0 ? cors({ origin: corsOrigins, credentials: true }) : cors({ origin: false }));

app.use(express.json({ limit: "2mb" }));

// ── Rate limit geral da API ───────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            120,
  message:        { error: "Muitas requisições. Aguarde alguns instantes." },
  standardHeaders: true,
  legacyHeaders:   false
});

// ── Rate limit dedicado para login (proteção contra força bruta) ──────────────
// NOVO: limite muito mais restrito — 10 tentativas por minuto por IP
const loginLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  message:         { error: "Muitas tentativas de login. Aguarde 1 minuto." },
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: true  // só conta falhas
});

app.use("/api", apiLimiter);
app.post("/api/auth/login", loginLimiter);
app.use(logger.httpLogger);

// ── Arquivos estáticos do painel ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "../frontend")));

// ── Rotas da API ──────────────────────────────────────────────────────────────
app.use("/api", authRouter);

// Rotas autenticadas (qualquer usuário logado)
app.use("/api", authSession, contactRoutes);
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: false, error: err.message });
  }
});

// ── Uploads autenticados (CORRIGIDO: era express.static público) ──────────────
// Fotos de perfil e imagens de campanha exigem sessão válida
const UPLOADS_DIR = path.join(__dirname, "uploads");

app.get("/uploads/*", authSession, (req, res) => {
  // Normaliza o path para evitar path traversal
  const relative = req.path.replace(/^\/uploads\//, "");
  const filePath  = path.resolve(UPLOADS_DIR, relative);

  // Garante que o arquivo resolvido ainda está dentro de UPLOADS_DIR
  if (!filePath.startsWith(UPLOADS_DIR + path.sep) && filePath !== UPLOADS_DIR) {
    return res.status(403).json({ error: "Acesso negado." });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Arquivo não encontrado." });
  }

  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(filePath);
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  logger.error(`[Express] ${req.method} ${req.path} — ${err.message}`);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "Erro interno do servidor." });
});

module.exports = app;
