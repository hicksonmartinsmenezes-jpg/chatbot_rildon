const express = require("express");
const crypto = require("crypto");

const pool = require("../database/postgres");
const upload = require("../middlewares/uploadProfile");
const { addLog } = require("../services/activityLog.service");

const {
  validateUser,
  updateUserProfile
} = require("../services/user.service");

const router = express.Router();

const SESSION_MS = 30 * 60 * 1000;

async function salvarSessao(token, session) {
  await pool.query(
    `
    INSERT INTO auth_sessions (token, user_data, expires_at, created_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (token)
    DO UPDATE SET
      user_data = EXCLUDED.user_data,
      expires_at = EXCLUDED.expires_at
    `,
    [token, JSON.stringify(session.user), session.expiresAt]
  );
}

async function buscarSessao(token) {
  const result = await pool.query(
    `
    SELECT token, user_data, expires_at
    FROM auth_sessions
    WHERE token = $1
    LIMIT 1
    `,
    [token]
  );

  const row = result.rows[0];

  if (!row) return null;

  if (Date.now() > Number(row.expires_at)) {
    await removerSessao(token);
    return null;
  }

  return {
    user: row.user_data,
    expiresAt: Number(row.expires_at)
  };
}

async function removerSessao(token) {
  await pool.query(
    `DELETE FROM auth_sessions WHERE token = $1`,
    [token]
  );
}

async function limparSessoesExpiradas() {
  await pool.query(
    `DELETE FROM auth_sessions WHERE expires_at < $1`,
    [Date.now()]
  );
}

function safeCompare(a, b) {
  const bufferA = Buffer.from(String(a || ""));
  const bufferB = Buffer.from(String(b || ""));

  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

router.post("/auth/login", async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    const user = await validateUser(usuario, senha);

    if (!user) {
      return res.status(401).json({
        error: "Usuário ou senha inválidos."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    await salvarSessao(token, {
      user,
      expiresAt: Date.now() + SESSION_MS
    });

    await addLog(user, "LOGIN", `${user.nome} entrou no sistema`);

    return res.json({
      token,
      user,
      expiresIn: SESSION_MS
    });
  } catch (error) {
    console.error("Erro no login:", error);

    return res.status(500).json({
      error: "Erro ao fazer login."
    });
  }
});

router.patch("/auth/me/profile", authSession, async (req, res) => {
  try {
    const updatedUser = await updateUserProfile(req.user.id, req.body || {});

    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (token) {
      await salvarSessao(token, {
        user: updatedUser,
        expiresAt: Date.now() + SESSION_MS
      });
    }

    await addLog(
      updatedUser,
      "UPDATE_PROFILE",
      `${updatedUser.nome} atualizou o perfil`
    );

    return res.json({ user: updatedUser });
  } catch (error) {
    return res.status(400).json({
      error: error.message
    });
  }
});

router.patch(
  "/auth/me/photo",
  authSession,
  upload.single("foto"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Nenhuma foto enviada."
        });
      }

      const foto = `/uploads/profiles/${req.file.filename}`;

      const updatedUser = await updateUserProfile(req.user.id, {
        nome: req.user.nome,
        numero: req.user.numero || "",
        foto
      });

      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      if (token) {
        await salvarSessao(token, {
          user: updatedUser,
          expiresAt: Date.now() + SESSION_MS
        });
      }

      await addLog(
        updatedUser,
        "UPDATE_PHOTO",
        `${updatedUser.nome} alterou a foto do perfil`
      );

      return res.json({
        success: true,
        foto,
        user: updatedUser
      });
    } catch (error) {
      return res.status(400).json({
        error: error.message || "Erro ao salvar foto."
      });
    }
  }
);

router.post("/auth/logout", async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (token) {
      const session = await buscarSessao(token);

      if (session?.user) {
        await addLog(
          session.user,
          "LOGOUT",
          `${session.user.nome} saiu do sistema`
        );
      }

      await removerSessao(token);
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.json({ ok: true });
  }
});

router.get("/auth/me", authSession, (req, res) => {
  return res.json({
    user: req.user
  });
});

async function authSession(req, res, next) {
  try {
    const apiToken = process.env.API_TOKEN;
    const auth = req.headers["authorization"] || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (!provided) {
      return res.status(401).json({
        error: "Token não fornecido."
      });
    }

    const session = await buscarSessao(provided);

    if (session) {
      await salvarSessao(provided, {
        user: session.user,
        expiresAt: Date.now() + SESSION_MS
      });

      req.user = session.user;
      return next();
    }

    if (apiToken && apiToken !== "troque-por-um-token-seguro-aqui") {
      const ok = safeCompare(provided, apiToken);

      if (ok) {
        req.user = {
          id: "api",
          nome: "Integração API",
          usuario: "api",
          perfil: "api"
        };

        return next();
      }
    }

    return res.status(401).json({
      error: "Sessão inválida ou expirada. Faça login novamente."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Erro ao validar sessão."
    });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.perfil)) {
      return res.status(403).json({
        error: "Acesso negado."
      });
    }

    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "Sessão inválida."
    });
  }

  if (req.user.perfil !== "admin") {
    return res.status(403).json({
      error: "Acesso permitido apenas para administradores."
    });
  }

  next();
}

setInterval(async () => {
  try {
    await limparSessoesExpiradas();
  } catch (_) {}
}, 5 * 60 * 1000);

module.exports = {
  router,
  authSession,
  requireAdmin,
  requireRole
};