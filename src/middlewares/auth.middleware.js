/**
 * Middleware de autenticação por Bearer Token.
 * Protege todas as rotas da API do painel.
 *
 * Para gerar um token seguro:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Configure API_TOKEN no .env antes de usar em produção.
 */

const logger = require("../utils/logger");

function authMiddleware(req, res, next) {
    const token = process.env.API_TOKEN;

    if (!token || token === "troque-por-um-token-seguro-aqui") {
        logger.warn("⚠️  API_TOKEN não configurado! Acesso à API liberado apenas em desenvolvimento.");
        return next();
    }

    const authHeader = req.headers["authorization"] || "";
    const provided   = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!provided || provided !== token) {
        return res.status(401).json({ error: "Não autorizado. Envie o header: Authorization: Bearer <API_TOKEN>" });
    }

    next();
}

module.exports = { authMiddleware };
