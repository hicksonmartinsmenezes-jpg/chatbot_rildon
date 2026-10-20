const express      = require("express");
const cors         = require("cors");
const path         = require("path");
const fs           = require("fs");
const helmet       = require("helmet");
const cookieParser = require("cookie-parser");
const logger       = require("./utils/logger");
const requestId    = require("./middlewares/request-id");
const { apiLimiter, apiIpLimiter, loginLimiter } = require("./middlewares/rate-limiters");
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
  requireScreenAccess
} = require("./routes/auth.routes");

const ticketRoutes   = require("./routes/ticket.routes");
const historyRoutes  = require("./routes/history.routes");
const messageRoutes  = require("./routes/message.routes");
const contactRoutes  = require("./routes/contact.routes");
const settingsRoutes    = require("./routes/settings.routes");
const botStatusRoutes   = require("./routes/botStatus.routes");
const atendenteRoutes   = require("./routes/atendentes.routes");
const catalogoRoutes    = require("./routes/catalogo.routes");
const { consultaCatalogoSemLogin } = require("./middlewares/catalogo-consulta");
// MCP somente-leitura (nova função, pedido do usuário 2026-09-09) —
// desligado por padrão via MCP_ENABLED, ver comentário no próprio
// mcp.routes.js/mcp.service.js.
const mcpRoutes         = require("./routes/mcp.routes");

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
      frameAncestors: ["'none'"],
      // Issue #22 (2026-08-26): pré-visualização do "Catálogo Completo"
      // embute o PDF gerado num <iframe src="blob:...">. Sem essa diretiva,
      // frame-src cai no fallback de defaultSrc ("'self'"), que NÃO cobre
      // blob: — o navegador bloqueia silenciosamente ("Este conteúdo está
      // bloqueado", sem erro nenhum no console) e o iframe mostra o ícone de
      // "documento quebrado" em vez do PDF. blob: é seguro aqui porque o
      // Blob é criado no próprio browser a partir de uma resposta do nosso
      // backend (fetch em /api/catalogo/exportar-pdf), nunca de conteúdo de
      // terceiros.
      frameSrc:       ["'self'", "blob:"],
      // CAUSA RAIZ REAL do ERR_SSL_PROTOCOL_ERROR em outros computadores
      // (2026-07-13): o Helmet, com useDefaults implícito (true), MESCLA
      // suas diretivas padrão às nossas — e uma delas é
      // "upgrade-insecure-requests", que manda QUALQUER navegador reescrever
      // sozinho toda URL relativa/http:// da página para https:// antes de
      // pedir o recurso. Esse deploy é HTTP puro na rede local (sem TLS em
      // lugar nenhum do projeto), então isso quebrava especificamente os
      // recursos do próprio servidor (bundle.css/js, socket.io.js, ícones)
      // — CDNs de terceiros (que já usam https:// explícito) não eram
      // afetados, por isso só uma parte dos recursos falhava. Confirmado
      // reproduzindo em navegador novo/sem histórico, o que descartou HSTS
      // e qualquer configuração salva no navegador. Setar como "null" aqui
      // remove essa diretiva do CSP final (ao contrário de HSTS, CSP não
      // fica "memorizado" pelo navegador — silenciar essa diretiva no
      // header já resolve na hora, sem precisar limpar nada no cliente).
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  // Este deploy é HTTP puro na rede local (sem TLS/reverse proxy configurado
  // em lugar nenhum do projeto) — mandar Strict-Transport-Security (HSTS)
  // e Cross-Origin-Opener-Policy aqui é enganoso: navegadores DEVEM ignorar
  // HSTS recebido por HTTP (RFC 6797 §8.1). Desligado por precaução, mas a
  // causa real do problema em outros computadores era a diretiva de CSP
  // "upgrade-insecure-requests" acima, não HSTS.
  hsts: false,
  crossOriginOpenerPolicy: false
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
app.use("/api", apiIpLimiter);
app.use("/api", apiLimiter);
app.post("/api/auth/login", loginLimiter);
app.post("/api/auth/login/verify-2fa", loginLimiter);
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

// MCP somente-leitura: autentica sozinho (MCP_API_TOKEN próprio, ver
// mcp.routes.js) e por isso precisa ser montado ANTES do authSession global
// abaixo. CORRIGIDO (varredura 2026-09-30): antes vinha depois de vários
// authSession e nunca era alcançado (o Bearer do MCP não é sessão -> 401).
// O handler retorna 404 quando MCP_ENABLED não é "true".
app.use("/api", mcpRoutes);

// Programa Windows da loja: consulta do catálogo sem login (só leitura, só rede
// interna, só com o cabeçalho do programa) — ver middlewares/catalogo-consulta.js.
// Precisa vir ANTES do authSession global abaixo.
app.use("/api", consultaCatalogoSemLogin(catalogoRoutes));

// A partir daqui tudo exige sessão. authSession roda UMA vez por requisição
// (antes rodava em cada mount, repetindo a consulta ao banco).
app.use("/api", authSession);

// Rotas liberadas a qualquer usuário logado: atendentes (dropdowns) e liga/
// desliga do bot (ver botStatus.routes.js).
app.use("/api", atendenteRoutes);
app.use("/api", botStatusRoutes);

// Acesso por tela, aplicado SÓ nos caminhos de cada router.
// CORRIGIDO (varredura 2026-09-30): antes cada `app.use("/api", authSession,
// requireScreenAccess(...), router)` rodava para TODA rota /api seguinte, então
// o 403 de uma tela bloqueava rotas de outras telas (ex.: usuário sem
// Contatos/Campanhas levava 403 em Tickets, Catálogo, Métricas...). Agora o
// gate só age quando o caminho pertence ao router.
// Mapeamento das telas mantido igual ao anterior (ver comentários históricos
// no git): contatos/campanhas usam /contacts; dashboard/conversas usam
// tickets e histórico; "chatbot" ou "settings" usam /settings; etc.
function gate(prefixes, ...screens) {
  const check = requireScreenAccess(...screens);
  return (req, res, next) => {
    const hit = prefixes.some(p => req.path === p || req.path.startsWith(p + "/"));
    return hit ? check(req, res, next) : next();
  };
}
// Respostas rápidas: leitura liberada a quem atende (Conversas); edição só
// para quem tem a tela Chatbot.
function gateQuickReplies(req, res, next) {
  const hit = req.path === "/quick-replies";
  if (!hit) return next();
  const screens = req.method === "GET" ? ["chatbot", "conversations"] : ["chatbot"];
  return requireScreenAccess(...screens)(req, res, next);
}

app.use("/api", gate(["/contacts"], "contacts", "channels"), contactRoutes);
app.use("/api", gate(["/tickets"], "dashboard", "conversations"), ticketRoutes);
app.use("/api", gate(["/history"], "dashboard", "conversations", "history"), historyRoutes);
app.use("/api", gate(["/catalogo"], "catalogo"), catalogoRoutes);
app.use("/api", gate(["/messages", "/whatsapp"], "conversations"), messageRoutes);
app.use("/api", gate(["/settings"], "chatbot", "settings"), settingsRoutes);
app.use("/api", gateQuickReplies, quickReplyRoutes);
app.use("/api", gate(["/users"], "settings"), userRoutes);
app.use("/api", gate(["/activity-logs"], "settings"), activityLogRoutes);
app.use("/api", gate(["/metrics"], "metrics"), metricsRoutes);
app.use("/api", gate(["/broadcasts", "/campaign-schedules"], "channels"), broadcastRoutes);

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

  res.setHeader("Cache-Control", "private, max-age=3600");
  // sendFile assíncrono já trata arquivo ausente (evita fs.existsSync
  // bloqueando o event loop a cada foto).
  res.sendFile(filePath, { dotfiles: "deny" }, (err) => {
    if (err && !res.headersSent) {
      res.status(err.code === "ENOENT" || err.status === 404 ? 404 : 500)
        .json({ error: err.code === "ENOENT" || err.status === 404 ? "Arquivo não encontrado." : "Erro ao ler arquivo." });
    }
  });
});

// ── 404 e Global error handler ──────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
