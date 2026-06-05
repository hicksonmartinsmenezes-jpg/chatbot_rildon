const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");

const {
  getUsers,
  createUser,
  updateUserPassword,
  deactivateUser
} = require("../services/user.service");

const { auditLog } = require("../services/audit.service");

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
  const users = await getUsers();
  res.json(users.map(sanitizeUser));
}));

router.post("/users", asyncHandler(async (req, res) => {
  const { nome, usuario, senha, perfil, sector, ativo } = req.body || {};

  if (!nome || !usuario || !senha) {
    return res.status(400).json({ error: "Nome, usuário e senha são obrigatórios." });
  }

  const user = await createUser({ nome, usuario, senha, perfil, sector, ativo });

  await auditLog({
    user:    req.user,
    action:  "CREATE_USER",
    target:  user.id,
    details: { nome: user.nome, usuario: user.usuario, perfil: user.perfil, sector: user.sector }
  });

  res.status(201).json(sanitizeUser(user));
}));

router.delete("/users/:id", asyncHandler(async (req, res) => {
  const users        = await getUsers();
  const userToDelete = users.find(u => u.id === req.params.id);

  if (!userToDelete) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  await deactivateUser(req.params.id);

  await auditLog({
    user:    req.user,
    action:  "DELETE_USER",
    target:  userToDelete.id,
    details: { nome: userToDelete.nome, usuario: userToDelete.usuario, perfil: userToDelete.perfil }
  });

  res.json({ ok: true });
}));

router.patch("/users/:id/password", asyncHandler(async (req, res) => {
  const { senha } = req.body || {};

  // CORRIGIDO: mínimo de 8 chars, consistente com updateUserProfile
  if (!senha || senha.length < 8) {
    return res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres." });
  }

  const users      = await getUsers();
  const targetUser = users.find(u => u.id === req.params.id);

  if (!targetUser) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  await updateUserPassword(req.params.id, senha);

  await auditLog({
    user:    req.user,
    action:  "RESET_PASSWORD",
    target:  req.params.id,
    details: { usuario: targetUser.usuario }
  });

  res.json({ ok: true });
}));

module.exports = router;
