const rateLimit = require("express-rate-limit");

function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false
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

module.exports = {
  apiLimiter,
  loginLimiter,
  messageLimiter,
  uploadLimiter,
  criticalActionLimiter
};
