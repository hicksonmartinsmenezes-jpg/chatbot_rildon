const rateLimit = require("express-rate-limit");

// BUG CORRIGIDO (relatado pelo usuário, 2026-07-31: "erro de muitas
// requisições com mais frequência"): todo limiter aqui usava a chave padrão
// do express-rate-limit, que é só o IP do cliente (req.ip). Nesse deploy os
// atendentes acessam o painel pela rede local pelo MESMO IP do servidor
// quando não há reverse proxy identificando cada máquina separadamente (ou,
// pior, quando vários atendentes ficam atrás do mesmo NAT/roteador) — nesse
// caso TODOS eles dividem um único balde de 300 requisições/min, e cada
// atendente faz várias chamadas em paralelo a cada poll de conversas
// (history + tickets + humanmode) mais os badges de notificação. Só
// aumentar o número (já feito antes, 120→300 no .env, ver comentário lá)
// não resolve de vez — é um remendo que volta a estourar conforme mais
// atendentes/abas entram. Fix real: cada atendente LOGADO tem seu próprio
// cookie de sessão (rildon_sid, ver auth.routes.js) — usar esse token como
// chave dá a CADA atendente o próprio orçamento de requisições, em vez de
// todos dividirem o mesmo balde por IP. Sem sessão (login, health-check
// etc.) cai no IP normal — ipKeyGenerator trata IPv6 corretamente (exigido
// pelo express-rate-limit v8 pra não warnar/quebrar em IPv6).
function chavePorSessaoOuIp(req) {
  const sid = req.cookies?.rildon_sid;
  return sid ? `sid:${sid}` : rateLimit.ipKeyGenerator(req.ip);
}

function makeLimiter({ windowMs, max, message, keyGenerator = chavePorSessaoOuIp }) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator
  });
}

const apiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 120),
  message: "Muitas requisições. Aguarde alguns instantes."
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  message: { error: "Muitas tentativas de login. Aguarde 1 minuto." },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

const messageLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.MESSAGE_RATE_LIMIT_MAX || 30),
  message: "Muitas mensagens em pouco tempo. Aguarde alguns instantes."
});

const uploadLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX || 30),
  message: "Muitos uploads em pouco tempo. Aguarde alguns instantes."
});

const criticalActionLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.CRITICAL_ACTION_RATE_LIMIT_MAX || 10),
  message: "Muitas ações críticas em pouco tempo. Aguarde alguns instantes."
});

// Chave própria pro MCP (nova função, 2026-09-09): usa o próprio token
// Bearer como identidade, não sessão de atendente (cliente MCP nunca manda
// cookie) nem só IP (mesmo motivo do bug corrigido acima — evita que MCP e
// os scripts do X2, que também autenticam por Bearer sem cookie, dividam um
// balde por IP). Seguro usar o token puro aqui porque este limiter só roda
// DEPOIS do middleware de autenticação de mcp.routes.js — ou seja, quando
// chega aqui o Bearer já foi validado contra MCP_API_TOKEN, nunca é um
// valor arbitrário que um cliente sem credencial poderia forjar pra ganhar
// baldes infinitos.
function chavePorTokenMcp(req) {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return token ? `mcp:${token}` : rateLimit.ipKeyGenerator(req.ip);
}

const mcpLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: Number(process.env.MCP_RATE_LIMIT_MAX || 30),
  message: "Muitas chamadas MCP em pouco tempo. Aguarde alguns instantes.",
  keyGenerator: chavePorTokenMcp
});

module.exports = {
  apiLimiter,
  loginLimiter,
  messageLimiter,
  uploadLimiter,
  criticalActionLimiter,
  mcpLimiter
};
