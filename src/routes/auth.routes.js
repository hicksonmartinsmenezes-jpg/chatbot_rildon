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

// BUG CORRIGIDO EM PRODUÇÃO (2026-07-13): "secure" estava ligado direto ao
// NODE_ENV==="production", mas o Dockerfile define NODE_ENV=production
// incondicionalmente (ENV NODE_ENV=production), mesmo neste deploy sem TLS
// nenhum (HTTP puro na rede local — ver docker-compose.yml, não há
// reverse proxy/certificado em lugar nenhum do projeto). Um cookie "Secure"
// é DESCARTADO pelo navegador em qualquer conexão que não seja HTTPS —
// exceto "localhost", que a maioria dos navegadores trata como origem
// confiável mesmo em HTTP puro. Por isso o login funcionava perfeitamente
// na própria máquina (acessada como "localhost") e falhava (sessão
// "expirando" a cada request, já que o cookie nunca voltava) em qualquer
// outro computador/IP da rede. "secure" agora é controlado por uma env var
// própria (COOKIE_SECURE), independente de NODE_ENV — só ligue se este
// servidor realmente estiver atrás de HTTPS (proxy reverso com TLS, etc.).
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "").toLowerCase() === "true";
const COOKIE_OPTIONS  = {
  httpOnly:  true,          // JS do cliente nunca acessa
  secure:    COOKIE_SECURE, // só true se COOKIE_SECURE=true no .env (deploy atrás de HTTPS)
  sameSite:  "strict",      // protege contra CSRF
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
  _sessaoCache.delete(token);
  await pool.query(`DELETE FROM auth_sessions WHERE token = $1`, [token]);
}

// ---------------------------------------------------------------------------
// Cache de sessão em memória
//
// 2026-10-09 (auditoria de performance): authSession roda em TODA requisição
// /api e fazia SEMPRE duas queries — o SELECT em auth_sessions e o SELECT de
// revalidação em users. Com o painel aberto em várias abas fazendo polling de
// status, isso eram centenas de queries por minuto só para dizer "sim, essa
// sessão continua válida", competindo por um pool de 20 conexões com o
// pipeline de mensagens do WhatsApp. Quando o pool saturava, o próprio
// authSession estourava com "Connection terminated due to connection timeout"
// — exatamente a linha que aparecia no log do usuário.
//
// TTL curto (15s por padrão) mantém a revalidação de ativo/perfil/permissões
// praticamente em tempo real: desativar um usuário continua derrubando o
// acesso dele em no máximo 15 segundos, e as operações que já invalidavam
// sessão na hora (logout, exclusão, troca de senha) chamam removerSessao /
// invalidarCacheSessao, que limpam o cache imediatamente.
// ---------------------------------------------------------------------------
const SESSAO_CACHE_TTL = Number(process.env.SESSION_CACHE_TTL_MS || 15000);
const _sessaoCache = new Map();   // token -> { user, expiresAt, at }

function invalidarCacheSessao(token = null) {
  if (token) _sessaoCache.delete(token);
  else _sessaoCache.clear();
}

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of _sessaoCache) {
    if (agora - v.at > SESSAO_CACHE_TTL || v.expiresAt <= agora) _sessaoCache.delete(k);
  }
}, 30000).unref();

async function limparSessoesExpiradas() {
  await pool.query(`DELETE FROM auth_sessions WHERE expires_at < $1`, [Date.now()]);
}

function safeCompare(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Mesmo formato salvo na sessão/retornado ao cliente — nunca inclui senha/2FA
 * secreto (só o flag booleano totpEnabled, necessário pro painel decidir se
 * mostra "Ativar 2FA" ou "Desativar 2FA"). */
function toSessionUser(user) {
  return {
    id: user.id,
    nome: user.nome,
    usuario: user.usuario,
    perfil: user.perfil,
    sector: user.sector || "geral",
    numero: user.numero || "",
    foto: user.foto || "",
    totpEnabled: !!user.totpEnabled,
    permissions: user.permissions || {}
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

// ─── Bloqueio temporário por conta (varredura 2026-09-30) ─────────────────────
// Senha é PIN de 4 dígitos (decisão do usuário), então o limite por IP não basta:
// vários IPs poderiam testar as 10.000 combinações. Após 5 erros seguidos na
// mesma conta, bloqueia novos logins dela por 15 min. Em memória (zera ao
// reiniciar o servidor) — suficiente para conter tentativa automatizada.
const LOGIN_MAX_FALHAS = Number(process.env.LOGIN_MAX_FAILURES) || 5;
const LOGIN_BLOQUEIO_MS = (Number(process.env.LOGIN_LOCK_MINUTES) || 15) * 60 * 1000;
const _falhasLogin = new Map(); // usuario -> { count, until }

function _chaveLogin(usuario) {
  return String(usuario || "").trim().toLowerCase().slice(0, 100);
}
function _bloqueadoAte(usuario) {
  const e = _falhasLogin.get(_chaveLogin(usuario));
  if (e?.until && e.until > Date.now()) return e.until;
  return 0;
}
function _registrarFalhaLogin(usuario) {
  const k = _chaveLogin(usuario);
  if (!k) return;
  const e = _falhasLogin.get(k) || { count: 0, until: 0 };
  if (e.until && e.until <= Date.now()) { e.count = 0; e.until = 0; }
  e.count += 1;
  if (e.count >= LOGIN_MAX_FALHAS) e.until = Date.now() + LOGIN_BLOQUEIO_MS;
  _falhasLogin.set(k, e);
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, e] of _falhasLogin) {
    if ((e.until && e.until <= agora) || _falhasLogin.size > 5000) _falhasLogin.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post("/auth/login", async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};

    const bloqueadoAte = _bloqueadoAte(usuario);
    if (bloqueadoAte) {
      const min = Math.max(1, Math.ceil((bloqueadoAte - Date.now()) / 60000));
      return res.status(429).json({ error: `Conta temporariamente bloqueada por excesso de tentativas. Tente novamente em ${min} min.` });
    }

    const user = await validateUser(usuario, senha);

    if (!user) {
      _registrarFalhaLogin(usuario);
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    _falhasLogin.delete(_chaveLogin(usuario));

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

    // A sessão em memória/banco ainda tem totpEnabled desatualizado — atualiza
    // aqui pra o painel refletir o novo estado sem precisar de outro login.
    const updatedUser = { ...req.user, totpEnabled: true };
    const token = extrairToken(req);
    if (token) {
      await salvarSessao(token, { user: updatedUser, expiresAt: Date.now() + SESSION_MS });
    }

    await addLog(req.user, "ENABLE_2FA", `${req.user.nome} ativou a autenticação de dois fatores`);

    return res.json({ ok: true, backupCodes, user: updatedUser });
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

    const updatedUser = { ...req.user, totpEnabled: false };
    const token = extrairToken(req);
    if (token) {
      await salvarSessao(token, { user: updatedUser, expiresAt: Date.now() + SESSION_MS });
    }

    await addLog(req.user, "DISABLE_2FA", `${req.user.nome} desativou a autenticação de dois fatores`);

    return res.json({ ok: true, user: updatedUser });
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

    // Acerto no cache: devolve sem tocar no banco. Ver comentário em
    // _sessaoCache — é o que tira ~95% das queries deste middleware, que roda
    // em toda requisição /api.
    const emCache = _sessaoCache.get(provided);
    if (emCache && Date.now() - emCache.at < SESSAO_CACHE_TTL && emCache.expiresAt > Date.now()) {
      req.user = emCache.user;
      return next();
    }

    const session = await buscarSessao(provided);

    if (!session) {
      _sessaoCache.delete(provided);
      res.clearCookie(COOKIE_NAME, { path: "/" });
      return res.status(401).json({ error: "Sessão inválida ou expirada. Faça login novamente." });
    }

    // Revalida se o usuário ainda está ativo no banco (detecta desativação/promoção em tempo real)
    if (session.user?.id && session.user.id !== "api") {
      const dbUser = await pool.query(
        `SELECT id, ativo, perfil, permissions FROM users WHERE id = $1 LIMIT 1`,
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
      session.user.permissions = row.permissions || {};
    }

    // Renova sessão apenas quando restar menos de 10 min (evita escrita a cada req)
    const RENEW_THRESHOLD = 10 * 60 * 1000;
    if (session.expiresAt - Date.now() < RENEW_THRESHOLD) {
      const newExpiry = Date.now() + SESSION_MS;
      await salvarSessao(provided, { user: session.user, expiresAt: newExpiry });
      res.cookie(COOKIE_NAME, provided, COOKIE_OPTIONS);
    }

    _sessaoCache.set(provided, {
      user:      session.user,
      expiresAt: session.expiresAt,
      at:        Date.now()
    });

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

// ─── Acesso por tela (permite override de qualquer tela pra qualquer perfil) ──
// Pedido do usuário (2026-09-19): até aqui, Chatbot/Configurações (e
// Campanhas/Métricas fora do teto do perfil) ficavam bloqueadas pra
// atendente/supervisor mesmo marcando o checkbox em "Acesso às telas" —
// o checkbox só existia no frontend (09-users.js), mas as rotas por trás
// continuavam presas em requireAdmin/requireRole, que olham só pro
// `perfil`, nunca pro `permissions` individual do usuário. Isso tornava a
// UI enganosa: marcar a tela "funcionava" (salvava no banco), só que a API
// respondia 403 do mesmo jeito.
//
// PROFILE_DEFAULT_SCREENS espelha exatamente PROFILE_SCREEN_ACCESS
// (user.service.js) e DEFAULT_SCREEN_PERMISSIONS (frontend/js/09-users.js)
// — as 3 cópias precisam ficar em sincronia; é a mesma duplicação de 3
// lugares já aceita no resto do projeto pra essa feature (ver comentário
// em normalizeScreenPermissions), não vale abstrair pra um módulo
// compartilhado só por isso (evitar overengineering, CLAUDE.md) porque
// frontend/backend não compartilham módulo hoje.
const PROFILE_DEFAULT_SCREENS = {
  atendente: new Set(["dashboard", "conversations", "history", "contacts"]),
  supervisor: new Set(["dashboard", "conversations", "history", "contacts", "channels", "metrics"])
};

// Perfil sugere um padrão (PROFILE_DEFAULT_SCREENS acima), mas a permissão
// individual (users.permissions, migration 027) sempre pode sobrepor — tanto
// pra LIBERAR uma tela fora do padrão do perfil (o pedido de hoje) quanto
// pra RETIRAR uma tela que o perfil teria por padrão (comportamento que já
// existia). Usuários antigos (antes de 2026-09-18) têm permissions='{}' —
// por isso o fallback pro padrão do perfil quando a chave está ausente é
// obrigatório, senão todo supervisor/admin antigo perderia acesso de
// uma hora pra outra ao trocar requireAdmin/requireRole por esta função.
function hasScreenAccess(user, screenId) {
  if (!user) return false;
  if (user.perfil === "admin") return true;
  const permissions = user.permissions || {};
  if (typeof permissions[screenId] === "boolean") return permissions[screenId];
  const defaultSet = PROFILE_DEFAULT_SCREENS[user.perfil] || PROFILE_DEFAULT_SCREENS.atendente;
  return defaultSet.has(screenId);
}

// requireScreenAccess("settings") — ou requireScreenAccess("chatbot",
// "settings") quando a mesma rota atende duas telas do menu (ex:
// settingsRoutes é usado tanto pela aba Chatbot quanto pela aba
// Configurações — ver comentário em app.js). Passa se o usuário tiver
// acesso a QUALQUER uma das telas informadas.
function requireScreenAccess(...screenIds) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sessão inválida." });
    if (screenIds.some(id => hasScreenAccess(req.user, id))) return next();
    return res.status(403).json({ error: "Acesso negado para este perfil." });
  };
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

module.exports = { router, authSession, requireAdmin, requireRole, requireScreenAccess, buscarSessao, invalidarCacheSessao };
