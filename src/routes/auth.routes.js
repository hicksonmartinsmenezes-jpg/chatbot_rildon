const logger  = require("../utils/logger");
const express = require("express");
const crypto  = require("crypto");
const bcrypt  = require("bcrypt");

const pool   = require("../database/postgres");
const upload = require("../middlewares/uploadProfile");
const { addLog } = require("../services/activityLog.service");
const twoFactorService = require("../services/twoFactor.service");
const userRepository = require("../repositories/user.repository");

const {
  validateUser,
  updateUserProfile
} = require("../services/user.service");

const router = express.Router();

// ─── Configuração do cookie de sessão ────────────────────────────────────────
// SESSION_TTL_MINUTES é opcional (default 30) — antes esse valor ficava
// hardcoded aqui e a variável documentada no .env.example/README nunca
// tinha efeito nenhum.
const SESSION_TTL_MINUTES = Number(process.env.SESSION_TTL_MINUTES) || 30;
const SESSION_MS      = SESSION_TTL_MINUTES * 60 * 1000;
const COOKIE_NAME     = "rildon_sid";
const COOKIE_OPTIONS  = {
  httpOnly:  true,                                   // JS do cliente nunca acessa
  secure:    process.env.NODE_ENV === "production",  // HTTPS obrigatório em prod
  sameSite:  "strict",                               // protege contra CSRF
  maxAge:    SESSION_MS,
  path:      "/"
};

// ─── Helpers de sessão no banco ───────────────────────────────────────────────
function extrairToken(req) {
  // 1. Cookie HttpOnly (caminho principal)
  if (req.cookies?.[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  // 2. Fallback: Authorization header (integração API externa / API_TOKEN)
  const auth = req.headers["authorization"] || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function salvarSessao(token, session) {
  await pool.query(
    `INSERT INTO auth_sessions (token, user_data, expires_at, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (token)
     DO UPDATE SET user_data = EXCLUDED.user_data, expires_at = EXCLUDED.expires_at`,
    [token, JSON.stringify(session.user), session.expiresAt]
  );
}

async function buscarSessao(token) {
  const result = await pool.query(
    `SELECT token, user_data, expires_at
     FROM auth_sessions WHERE token = $1 LIMIT 1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) return null;

  if (Date.now() > Number(row.expires_at)) {
    await removerSessao(token);
    return null;
  }

  return { user: row.user_data, expiresAt: Number(row.expires_at) };
}

async function removerSessao(token) {
  await pool.query(`DELETE FROM auth_sessions WHERE token = $1`, [token]);
}

async function limparSessoesExpiradas() {
  await pool.query(`DELETE FROM auth_sessions WHERE expires_at < $1`, [Date.now()]);
}

function safeCompare(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Mesmo formato salvo na sessão/retornado ao cliente — nunca inclui senha/2FA. */
function toSessionUser(user) {
  return {
    id: user.id,
    nome: user.nome,
    usuario: user.usuario,
    perfil: user.perfil,
    sector: user.sector || "geral",
    numero: user.numero || "",
    foto: user.foto || ""
  };
}

async function abrirSessao(res, user, extra = {}) {
  const token = crypto.randomBytes(32).toString("hex");

  await salvarSessao(token, {
    user,
    expiresAt: Date.now() + SESSION_MS
  });

  await addLog(user, "LOGIN", `${user.nome} entrou no sistema`);

  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);

  return res.json({ user, expiresIn: SESSION_MS, ...extra });
}

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/auth/login", async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    const user = await validateUser(usuario, senha);

    if (!user) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    // 2FA ativo: não abre sessão ainda — exige um segundo passo com o código.
    const fullUser = await userRepository.findById(user.id);
    if (fullUser?.totpEnabled) {
      const { token: challengeToken, expiresIn } = await twoFactorService.criarDesafioLogin(user.id);
      return res.json({ requiresTwoFactor: true, challengeToken, expiresIn });
    }

    return await abrirSessao(res, user);
  } catch (error) {
    logger.error(`[auth/login] ${error.message}`);
    return res.status(500).json({ error: "Erro ao fazer login." });
  }
});

// ─── POST /api/auth/login/verify-2fa ─────────────────────────────────────────
// Segundo passo do login quando o usuário tem 2FA ativo. Recebe o token do
// desafio (gerado em /auth/login) + o código do app autenticador (ou um
// backup code). Só abre sessão de verdade se o código bater.
router.post("/auth/login/verify-2fa", async (req, res) => {
  try {
    const { challengeToken, codigo } = req.body || {};

    if (!challengeToken || !codigo) {
      return res.status(400).json({ error: "Token de desafio e código são obrigatórios." });
    }

    let resultado;
    try {
      resultado = await twoFactorService.verificarDesafioLogin(challengeToken, codigo);
    } catch (err) {
      return res.status(401).json({ error: err.message });
    }

    const fullUser = await userRepository.findById(resultado.userId);
    if (!fullUser || fullUser.ativo === false) {
      return res.status(401).json({ error: "Usuário inválido ou inativo." });
    }

    return await abrirSessao(res, toSessionUser(fullUser), {
      usouBackupCode: !!resultado.usouBackupCode
    });
  } catch (error) {
    logger.error(`[auth/login/verify-2fa] ${error.message}`);
    return res.status(500).json({ error: "Erro ao verificar código." });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post("/auth/logout", async (req, res) => {
  try {
    const token = extrairToken(req);

    if (token) {
      const session = await buscarSessao(token);
      if (session?.user) {
        await addLog(session.user, "LOGOUT", `${session.user.nome} saiu do sistema`);
      }
      await removerSessao(token);
    }

    // Apaga o cookie no navegador
    res.clearCookie(COOKIE_NAME, { path: "/" });
    return res.json({ ok: true });
  } catch {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    return res.json({ ok: true });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get("/auth/me", authSession, (req, res) => {
  return res.json({ user: req.user });
});

// ─── PATCH /api/auth/me/profile ───────────────────────────────────────────────
router.patch("/auth/me/profile", authSession, async (req, res) => {
  try {
    const updatedUser = await updateUserProfile(req.user.id, req.body || {});
    const token       = extrairToken(req);

    if (token) {
      await salvarSessao(token, {
        user:      updatedUser,
        expiresAt: Date.now() + SESSION_MS
      });
    }

    await addLog(updatedUser, "UPDATE_PROFILE", `${updatedUser.nome} atualizou o perfil`);
    return res.json({ user: updatedUser });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// ─── PATCH /api/auth/me/photo ─────────────────────────────────────────────────
router.patch("/auth/me/photo", authSession, upload.single("foto"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhuma foto enviada." });
    }

    const foto        = `/uploads/profiles/${req.file.filename}`;
    const updatedUser = await updateUserProfile(req.user.id, {
      nome:   req.user.nome,
      numero: req.user.numero || "",
      foto
    });

    const token = extrairToken(req);
    if (token) {
      await salvarSessao(token, {
        user:      updatedUser,
        expiresAt: Date.now() + SESSION_MS
      });
    }

    await addLog(updatedUser, "UPDATE_PHOTO", `${updatedUser.nome} alterou a foto do perfil`);
    return res.json({ success: true, foto, user: updatedUser });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Erro ao salvar foto." });
  }
});

// ─── POST /api/auth/2fa/setup ─────────────────────────────────────────────────
// Gera um segredo pendente + QR code. Não ativa o 2FA até /2fa/confirm.
router.post("/auth/2fa/setup", authSession, async (req, res) => {
  try {
    const { secret, qrCodeDataUrl } = await twoFactorService.setup(req.user.id, req.user.usuario);
    return res.json({ secret, qrCodeDataUrl });
  } catch (error) {
    logger.error(`[auth/2fa/setup] ${error.message}`);
    return res.status(500).json({ error: "Erro ao iniciar configuração do 2FA." });
  }
});

// ─── POST /api/auth/2fa/confirm ───────────────────────────────────────────────
// Confirma o setup com um código do app autenticador. Retorna os backup
// codes em texto puro — só aparecem aqui, uma única vez.
router.post("/auth/2fa/confirm", authSession, async (req, res) => {
  try {
    const { codigo } = req.body || {};
    if (!codigo) {
      return res.status(400).json({ error: "Código é obrigatório." });
    }

    const { backupCodes } = await twoFactorService.confirmSetup(req.user.id, codigo);

    await addLog(req.user, "ENABLE_2FA", `${req.user.nome} ativou a autenticação de dois fatores`);

    return res.json({ ok: true, backupCodes });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// ─── POST /api/auth/2fa/disable ───────────────────────────────────────────────
// Exige a senha atual para desligar — é um passo que reduz a segurança da
// conta, então não pode depender só da sessão já aberta.
router.post("/auth/2fa/disable", authSession, async (req, res) => {
  try {
    const { senha } = req.body || {};
    if (!senha) {
      return res.status(400).json({ error: "Confirme sua senha atual para desativar o 2FA." });
    }

    const fullUser = await userRepository.findById(req.user.id);
    const senhaOk  = await bcrypt.compare(String(senha), String(fullUser?.senha || ""));

    if (!senhaOk) {
      return res.status(401).json({ error: "Senha incorreta." });
    }

    await twoFactorService.disable(req.user.id);
    await addLog(req.user, "DISABLE_2FA", `${req.user.nome} desativou a autenticação de dois fatores`);

    return res.json({ ok: true });
  } catch (error) {
    logger.error(`[auth/2fa/disable] ${error.message}`);
    return res.status(500).json({ error: "Erro ao desativar 2FA." });
  }
});

// ─── Middleware de sessão ─────────────────────────────────────────────────────
async function authSession(req, res, next) {
  try {
    const provided = extrairToken(req);

    if (!provided) {
      return res.status(401).json({ error: "Sessão não encontrada. Faça login novamente." });
    }

    // Verifica API_TOKEN para integrações externas (fallback via header)
    const apiToken = process.env.API_TOKEN;
    if (apiToken && apiToken !== "troque-por-um-token-seguro-aqui") {
      if (safeCompare(provided, apiToken)) {
        req.user = { id: "api", nome: "Integração API", usuario: "api", perfil: "api" };
        return next();
      }
    }

    const session = await buscarSessao(provided);

    if (!session) {
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.status(401).json({ error: "Sessão inválida ou expirada. Faça login novamente." });
    }

    // Revalida se o usuário ainda está ativo no banco (detecta desativação/promoção em tempo real)
    if (session.user?.id && session.user.id !== "api") {
      const dbUser = await pool.query(
        `SELECT id, ativo, perfil FROM users WHERE id = $1 LIMIT 1`,
        [session.user.id]
      );
      const row = dbUser.rows[0];
      if (!row || row.ativo === false) {
        await removerSessao(provided);
        res.clearCookie(COOKIE_NAME, { path: "/" });
        return res.status(401).json({ error: "Usuário inativo. Faça login novamente." });
      }
      // Atualiza perfil na sessão caso tenha mudado
      if (row.perfil !== session.user.perfil) {
        session.user.perfil = row.perfil;
      }
    }

    // Renova sessão apenas quando restar menos de 10 min (evita escrita a cada req)
    const RENEW_THRESHOLD = 10 * 60 * 1000;
    if (session.expiresAt - Date.now() < RENEW_THRESHOLD) {
      const newExpiry = Date.now() + SESSION_MS;
      await salvarSessao(provided, { user: session.user, expiresAt: newExpiry });
      res.cookie(COOKIE_NAME, provided, COOKIE_OPTIONS);
    }

    req.user = session.user;
    return next();
  } catch (error) {
    logger.error(`[authSession] ${error.message}`);
    return res.status(500).json({ error: "Erro ao validar sessão." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.perfil)) {
      return res.status(403).json({ error: "Acesso negado." });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sessão inválida." });
  if (req.user.perfil !== "admin") {
    return res.status(403).json({ error: "Acesso permitido apenas para administradores." });
  }
  next();
}

// Limpeza de sessões expiradas a cada 5 min.
// unref(): não deve ser o único motivo do processo continuar rodando (não
// atrapalha shutdown gracioso) — e evita que testes/scripts que só fazem
// require() deste módulo fiquem pendurados esperando o timer.
setInterval(async () => {
  try { await limparSessoesExpiradas(); } catch (_) {}
}, 5 * 60 * 1000).unref();

// Limpeza de desafios de 2FA expirados a cada 5 min
setInterval(async () => {
  try { await twoFactorService.limparDesafiosExpirados(); } catch (_) {}
}, 5 * 60 * 1000).unref();

module.exports = { router, authSession, requireAdmin, requireRole, buscarSessao };
