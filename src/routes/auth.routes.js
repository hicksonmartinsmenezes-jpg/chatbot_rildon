const express = require("express");
const crypto  = require("crypto");
const fs      = require("fs");
const path    = require("path");

const upload = require("../middlewares/uploadProfile");
const { addLog } = require("../services/activityLog.service");

const {
  validateUser,
  updateUserProfile,
  getUsers,
  saveUsers
} = require("../services/user.service");

const logger = require("../utils/logger");

const router = express.Router();

const sessionsFile = path.join(__dirname, "../data/auth_sessions.json");

const sessions = new Map();
const SESSION_MS = 30 * 60 * 1000;

function saveSessions() {
  try {
    const data = Array.from(sessions.entries());
    fs.writeFileSync(sessionsFile, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error(`Erro ao salvar sessões: ${err.message}`);
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(sessionsFile)) return;

    const raw = fs.readFileSync(sessionsFile, "utf8");
    const parsed = JSON.parse(raw || "[]");

    sessions.clear();

    for (const [token, session] of parsed) {
      sessions.set(token, session);
    }

    logger.info(`♻️ ${sessions.size} sessão(ões) de login restaurada(s).`);
  } catch (err) {
    logger.error(`Erro ao carregar sessões: ${err.message}`);
  }
}

loadSessions();

function limparSessoesExpiradas() {
  const agora = Date.now();
  let removeu = false;

  for (const [token, session] of sessions) {
    if (agora > session.expiresAt) {
      sessions.delete(token);
      removeu = true;
    }
  }

  if (removeu) saveSessions();
}

function safeCompare(a, b) {
  const bufferA = Buffer.from(String(a || ""));
  const bufferB = Buffer.from(String(b || ""));

  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

router.post("/auth/login", async (req, res) => {
  try {
    limparSessoesExpiradas();

    const { usuario, senha } = req.body || {};
    const user = await validateUser(usuario, senha);

    if (!user) {
      return res.status(401).json({
        error: "Usuário ou senha inválidos."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
      expiresAt: Date.now() + SESSION_MS,
      user
    });

    saveSessions();

    await addLog(
      user,
      "LOGIN",
      `${user.nome} entrou no sistema`
    );

    res.json({
      token,
      user,
      expiresIn: SESSION_MS
    });
  } catch (error) {
    res.status(500).json({
      error: "Erro ao fazer login."
    });
  }
});

router.patch("/auth/me/profile", authSession, async (req, res) => {
  try {
    const updatedUser = await updateUserProfile(req.user.id, req.body || {});

    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const session = token ? sessions.get(token) : null;

    if (session) {
      session.user = updatedUser;
      session.expiresAt = Date.now() + SESSION_MS;
      sessions.set(token, session);
      saveSessions();
    }

    await addLog(
      updatedUser,
      "UPDATE_PROFILE",
      `${updatedUser.nome} atualizou o perfil`
    );

    res.json({ user: updatedUser });
  } catch (error) {
    res.status(400).json({ error: error.message });
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

      const users = await getUsers();
      const index = users.findIndex(u => u.id === req.user.id);

      if (index === -1) {
        return res.status(404).json({
          error: "Usuário não encontrado."
        });
      }

      const foto = `/uploads/profiles/${req.file.filename}`;

      users[index].foto = foto;

      await saveUsers(users);

      const updatedUser = {
        ...req.user,
        foto
      };

      const auth = req.headers["authorization"] || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
      const session = token ? sessions.get(token) : null;

      if (session) {
        session.user = updatedUser;
        session.expiresAt = Date.now() + SESSION_MS;
        sessions.set(token, session);
        saveSessions();
      }

      await addLog(
        req.user,
        "UPDATE_PHOTO",
        `${req.user.nome} alterou a foto do perfil`
      );

      res.json({
        success: true,
        foto,
        user: updatedUser
      });
    } catch (error) {
      res.status(400).json({
        error: error.message || "Erro ao salvar foto."
      });
    }
  }
);

router.post("/auth/logout", async (req, res) => {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (token) {
    const session = sessions.get(token);

    if (session?.user) {
      await addLog(
        session.user,
        "LOGOUT",
        `${session.user.nome} saiu do sistema`
      );
    }

    sessions.delete(token);
    saveSessions();
  }

  res.json({ ok: true });
});

router.get("/auth/me", authSession, (req, res) => {
  res.json({
    user: req.user
  });
});

function authSession(req, res, next) {
  limparSessoesExpiradas();

  const apiToken = process.env.API_TOKEN;
  const auth = req.headers["authorization"] || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!provided) {
    return res.status(401).json({
      error: "Token não fornecido."
    });
  }

  const session = sessions.get(provided);

  if (session) {
    session.expiresAt = Date.now() + SESSION_MS;
    sessions.set(provided, session);
    saveSessions();

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

setInterval(() => {
  limparSessoesExpiradas();
}, 5 * 60 * 1000);

module.exports = {
  router,
  authSession,
  requireAdmin,
  requireRole
};