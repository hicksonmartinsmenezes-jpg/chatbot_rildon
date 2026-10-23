// App Express do CATÁLOGO da loja, em processo próprio (contêiner "catalogo").
// Só atende o programa Windows da loja (consulta/edição sem login, rede interna + cabeçalho do
// programa) e os avisos internos do painel. Não tem WhatsApp, sockets nem sessões de usuário:
// por isso o que acontece no atendimento não deixa o catálogo lento.
const express = require("express");
const helmet = require("helmet");
const logger = require("./utils/logger");
const requestId = require("./middlewares/request-id");
const { apiIpLimiter } = require("./middlewares/rate-limiters");
const { notFoundHandler, errorHandler } = require("./middlewares/error-handler");
const catalogoRoutes = require("./routes/catalogo.routes");
const internoRoutes = require("./routes/interno.routes");
const { consultaCatalogoSemLogin } = require("./middlewares/catalogo-consulta");

const app = express();
app.set("trust proxy", false);
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(requestId);
app.use(logger.httpLogger);

app.get("/health", (req, res) => res.json({ status: "ok", processo: "catalogo", uptime: process.uptime() }));
app.get("/api/health", (req, res) => res.json({ status: "ok", processo: "catalogo", uptime: process.uptime() }));

app.use("/api", apiIpLimiter);
app.use("/api", internoRoutes);
app.use("/api", consultaCatalogoSemLogin(catalogoRoutes));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
