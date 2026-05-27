const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const logger = require("./utils/logger");
const quickReplyRoutes = require("./routes/quickReply.routes");
const userRoutes = require("./routes/user.routes");
const activityLogRoutes = require("./routes/activityLog.routes");
const metricsRoutes = require("./routes/metrics.routes");

const {
  router: authRouter,
  authSession,
  requireAdmin
} = require("./routes/auth.routes");

const ticketRoutes = require("./routes/ticket.routes");
const historyRoutes = require("./routes/history.routes");
const messageRoutes = require("./routes/message.routes");
const contactRoutes = require("./routes/contact.routes");
const settingsRoutes = require("./routes/settings.routes");

const app = express();

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(cors());

app.use(express.json({
  limit: "2mb"
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    error: "Muitas requisições. Aguarde alguns instantes."
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", apiLimiter);
app.use(logger.httpLogger);

// Arquivos estáticos do painel
app.use(express.static(path.join(__dirname, "../frontend")));

// Login/logout
app.use("/api", authRouter);

// Rotas públicas/sem sessão
app.use("/api", contactRoutes);

// Rotas autenticadas
app.use("/api", authSession, ticketRoutes);
app.use("/api", authSession, historyRoutes);
app.use("/api", authSession, messageRoutes);

// Rotas apenas admin
app.use("/api", authSession, requireAdmin, settingsRoutes);
app.use("/api", authSession, requireAdmin, quickReplyRoutes);
app.use("/api", authSession, requireAdmin, userRoutes);
app.use("/api", authSession, requireAdmin, activityLogRoutes);
app.use("/api", authSession, metricsRoutes);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime()
  });
});

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

module.exports = app;