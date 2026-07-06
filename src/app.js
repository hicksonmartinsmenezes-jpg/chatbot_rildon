const express      = require("express");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");
const helmet       = require("helmet");
const cookieParser = require("cookie-parser");
const logger       = require("./utils/logger");
const requestId    = require("./middlewares/request-id");
const { apiLimiter, loginLimiter } = require("./middlewares/rate-limiters");
const { notFoundHandler, errorHandler } = require("./middlewares/error-handler");

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
const settingsRoutes    = require("./routes/settings.routes");
const atendenteRoutes   = require("./routes/atendentes.routes");

const app = express();

// Atrás de proxy reverso, defina TRUST_PROXY com o nº de hops para que req.ip
// reflita o cliente real (rate-limit por IP + auditoria). Sem proxy, mantenha
// desligado — confiar em X-Forwarded-For permitiria spoof do IP do cliente.
const TRUST_PROXY = process.env.TRUST_PROXY;
app.set("trust proxy", TRUST_PROXY == null ? false : (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY));

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

// ── CORS configurável via .env — credentials:true obrigatório para cookies ───
const _corsRaw = (process.env.CORS_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
const _validOriginRe = /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?$/;
const corsOrigins = _corsRaw.filter(o => _validOriginRe.test(o));
app.use(corsOrigins.length > 0
  ? cors({ origin: corsOrigins, credentials: true })
  : cors({ origin: false })
);

// ── Cookie parser — necessário para ler o cookie HttpOnly de sessão ───────────
app.use(cookieParser());

app.use(express.json({ limit: "2mb" }));

// ── Identificação de requisições, rate limit e logs ───────────────────────────
app.use(requestId);
app.use("/api", apiLimiter);
app.post("/api/auth/login", loginLimiter);
app.use(logger.httpLogger);

// ── Arquivos estáticos do painel ─────────────────────────────────────────────
// Compatível com dois cenários:
// 1) pacote integrado: backend/src/app.js + ../../frontend
// 2) backend isolado: backend/src/app.js + ../frontend
const FRONTEND_DIR_CANDIDATES = [
  path.resolve(__dirname, "../../frontend"),
  path.resolve(__dirname, "../frontend")
];
const FRONTEND_DIR = FRONTEND_DIR_CANDIDATES.find(dir => fs.existsSync(path.join(dir, "index.html")));

if (FRONTEND_DIR) {
  app.use(express.static(FRONTEND_DIR, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store")
  }));
} else {
  logger.warn("[Static] Frontend não encontrado. Apenas a API será servida.");
}


// ── Sons opcionais do painel ────────────────────────────────────────────────
// Se o frontend tentar tocar um som que não existe no pacote, não retorna 404.
// Isso evita poluição no console; o play() no navegador deve falhar silenciosamente.
app.get(["/sounds/message.ogg", "/sounds/ticket.ogg"], (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  return res.status(204).end();
});

// ── Health checks (públicos — registrados ANTES da autenticação) ─────────────
app.get("/health", healthCheck);
app.get("/api/health", healthCheck);
app.get("/api/ready", healthCheck);
app.get("/api/live", (req, res) => res.json({ status: "ok", uptime: process.uptime(), requestId: req.id }));

// ── Rotas da API ──────────────────────────────────────────────────────────────
app.use("/api", authRouter);

// Rotas autenticadas (qualquer usuário logado)
app.use("/api", authSession, atendenteRoutes);
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

// ── Health check handler (rotas registradas antes da autenticação) ───────────
async function healthCheck(req, res) {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: true, uptime: process.uptime(), requestId: req.id });
  } catch (err) {
    res.status(503).json({ status: "degraded", db: false, error: "Banco indisponível.", requestId: req.id });
  }
}

// ── Uploads (imagens de perfil / campanha) ───────────────────────────────────
// Servidos publicamente: tags <img> não carregam o cookie de sessão de forma
// confiável (authSession retornava 401 e as fotos sumiam). Os nomes de arquivo
// são UUID+timestamp (não-adivinháveis) e o conteúdo é de baixa sensibilidade.
// Mantém-se a proteção contra path traversal.
const UPLOADS_DIR = path.join(__dirname, "uploads");

app.get("/uploads/*", (req, res) => {
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

// ── 404 e Global error handler ──────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
