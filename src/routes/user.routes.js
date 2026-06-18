const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const pool         = require("../database/postgres");

const {
  getUsers,
  getUserById,
  countActiveAdmins,
  createUser,
  updateUserPassword,
  deactivateUser
} = require("../services/user.service");

const { auditLog } = require("../services/audit.service");
const { emitEvent } = require("../services/socket.service");

const router = express.Router();

// requireAdmin já é aplicado em app.js para todas as rotas de /api/users
// requireRole("admin") interno removido — checagem dupla desnecessária

function sanitizeUser(user) {
  return {
    id:      user.id,
    nome:    user.nome,
    usuario: user.usuario,
    perfil:  user.perfil,
    sector:  user.sector || "geral",
    numero:  user.numero || "",
    foto:    user.foto   || "",
    ativo:   user.ativo
  };
}

router.get("/users", asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";
  const users = await getUsers({ includeInactive });
  res.json(users.map(sanitizeUser));
}));

router.post("/users", asyncHandler(async (req, res) => {
  const { nome, usuario, senha, perfil, sector, ativo } = req.body || {};

  if (!nome || !usuario || !senha) {
    return res.status(400).json({ error: "Nome, usuário e senha são obrigatórios." });
  }

  // Apenas admin pode criar outro admin
  if (perfil === "admin" && req.user?.perfil !== "admin") {
    return res.status(403).json({ error: "Apenas administradores podem criar outros administradores." });
  }

  let user;
  try {
    user = await createUser({ nome, usuario, senha, perfil, sector, ativo });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await auditLog({
    user:    req.user,
    action:  "CREATE_USER",
    target:  user.id,
    details: { nome: user.nome, usuario: user.usuario, perfil: user.perfil, sector: user.sector }
  });

  emitEvent("users_updated", { action: "created", user: sanitizeUser(user) });

  res.status(201).json(sanitizeUser(user));
}));

router.delete("/users/:id", asyncHandler(async (req, res) => {
  const targetId = String(req.params.id || "");

  if (String(req.user?.id || "") === targetId) {
    return res.status(400).json({ error: "Você não pode excluir seu próprio usuário logado." });
  }

  const userToDelete = await getUserById(targetId);

  if (!userToDelete || userToDelete.ativo === false) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  if (userToDelete.perfil === "admin") {
    const totalAdmins = await countActiveAdmins();
    if (totalAdmins <= 1) {
      return res.status(400).json({ error: "Não é possível excluir o último administrador ativo." });
    }
  }

  await deactivateUser(targetId);

  // Invalida imediatamente todas as sessões ativas do usuário desativado
  await pool.query(
    `DELETE FROM auth_sessions WHERE user_data::jsonb->>'id' = $1`,
    [targetId]
  );

  await auditLog({
    user:    req.user,
    action:  "DELETE_USER",
    target:  userToDelete.id,
    details: { nome: userToDelete.nome, usuario: userToDelete.usuario, perfil: userToDelete.perfil }
  });

  emitEvent("users_updated", { action: "deleted", id: targetId });

  res.json({ ok: true, id: targetId });
}));

router.patch("/users/:id/password", asyncHandler(async (req, res) => {
  const { senha } = req.body || {};

  // CORRIGIDO: mínimo de 8 chars, consistente com updateUserProfile
  if (!senha || senha.length < 8) {
    return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });
  }

  const targetUser = await getUserById(req.params.id);

  if (!targetUser || targetUser.ativo === false) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  await updateUserPassword(req.params.id, senha);

  await auditLog({
    user:    req.user,
    action:  "RESET_PASSWORD",
    target:  req.params.id,
    details: { usuario: targetUser.usuario }
  });

  emitEvent("users_updated", { action: "password_reset", id: req.params.id });

  res.json({ ok: true });
}));

module.exports = router;
