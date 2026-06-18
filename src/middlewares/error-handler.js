const logger = require("../utils/logger");

function notFoundHandler(req, res) {
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(404).json({ error: "Rota não encontrada." });
  }
  return res.status(404).send("Página não encontrada.");
}

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = Number(err.status || err.statusCode || 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const requestId = req.id || req.headers["x-request-id"] || "";
  const context = `${req.method} ${req.originalUrl || req.path}${requestId ? ` #${requestId}` : ""}`;

  if (safeStatus >= 500) {
    logger.error(`[Express] ${context} ${safeStatus} — ${err.stack || err.message || err}`);
  } else {
    logger.warn(`[Express] ${context} ${safeStatus} — ${err.message || "Erro de requisição"}`);
  }

  if (res.headersSent) return next(err);

  return res.status(safeStatus).json({
    error: safeStatus >= 500 ? "Erro interno do servidor." : (err.message || "Erro de requisição."),
    ...(requestId ? { requestId } : {})
  });
}

module.exports = {
  notFoundHandler,
  errorHandler
};
