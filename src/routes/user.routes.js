const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const pool         = require("../database/postgres");

const {
  getUsers,
  getUserById,
  countActiveAdmins,
  createUser,
  updateUserPassword,
  deactivateUser,
  updateUserPermissions
} = require("../services/user.service");

const { auditLog } = require("../services/audit.service");
const { emitEvent } = require("../services/socket.service");

const router = express.Router();

// CORRIGIDO (varredura 2026-09-30): como as rotas de usuário passaram de
// requireAdmin para a tela "settings", um supervisor/atendente com essa tela
// conseguia redefinir a senha, alterar permissões ou excluir um ADMIN. Só um
// admin pode agir sobre outro admin.
function bloquearSeAlvoAdmin(req, res, targetUser) {
  if (targetUser?.perfil === "admin" && req.user?.perfil !== "admin") {
    res.status(403).json({ error: "Apenas administradores podem alterar outro administrador." });
    return true;
  }
  return false;
}

// requireScreenAccess("settings") já é aplicado em app.js para todas as
// rotas de /api/users (trocado de requireAdmin em 2026-09-19 — ver
// comentário em app.js/auth.routes.js: agora um atendente/supervisor com a
// tela "settings" liberada individualmente também gerencia usuários, não
// só admin). requireRole("admin") interno removido — checagem dupla
// desnecessária.

function sanitizeUser(user) {
  return {
    id:      user.id,
    nome:    user.nome,
    usuario: user.usuario,
    perfil:  user.perfil,
    sector:  user.sector || "geral",
    numero:  user.numero || "",
    foto:    user.foto   || "",
    ativo:   user.ativo,
    permissions: user.permissions || {}
  };
}

router.get("/users", asyncHandler(async (req, res) => {
  const includeInactive = req.query.includeInactive === "true";
  const users = await getUsers({ includeInactive });

  // Pedido do usuário: no painel Usuários, mostrar quem está "em
  // atendimento" agora (tem ao menos 1 ticket em_andamento assumido) ao
  // lado do status online/offline. Uma única query agregada evita 1
  // consulta por usuário — mapeia assigned_to -> contagem de tickets ativos.
  const ativosRes = await pool.query(
    `SELECT assigned_to, COUNT(*)::int AS total
     FROM tickets
     WHERE status = 'em_andamento' AND assigned_to IS NOT NULL
     GROUP BY assigned_to`
  );
  const ticketsAtivosPorUsuario = new Map(
    ativosRes.rows.map(r => [String(r.assigned_to), r.total])
  );

  res.json(users.map(u => ({
    ...sanitizeUser(u),
    ticketsAtivos: ticketsAtivosPorUsuario.get(String(u.id)) || 0
  })));
}));

router.post("/users", asyncHandler(async (req, res) => {
  // Pedido do usuário: poder vincular um número de telefone/WhatsApp
  // pessoal ao criar o usuário — createUser()/user.service.js já suporta
  // "numero" de ponta a ponta (usado também na edição do próprio perfil),
  // só faltava esta rota repassar o campo do corpo da requisição.
  const { nome, usuario, senha, perfil, numero, ativo, permissions } = req.body || {};

  if (!nome || !usuario || !senha) {
    return res.status(400).json({ error: "Nome, usuário e senha são obrigatórios." });
  }

  // Apenas admin pode criar outro admin
  if (perfil === "admin" && req.user?.perfil !== "admin") {
    return res.status(403).json({ error: "Apenas administradores podem criar outros administradores." });
  }

  let user;
  try {
    user = await createUser({ nome, usuario, senha, perfil, numero, ativo, permissions });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await auditLog({
    user:    req.user,
    action:  user.reactivated ? "REACTIVATE_USER" : "CREATE_USER",
    target:  user.id,
    details: { nome: user.nome, usuario: user.usuario, perfil: user.perfil, sector: user.sector }
  });

  emitEvent("users_updated", { action: user.reactivated ? "reactivated" : "created", user: sanitizeUser(user) });

  // 201 para usuário novo; 200 para reativação de um usuário antes excluído
  // (mesmo "usuario" — ver comentário em createUser()/user.service.js).
  res.status(user.reactivated ? 200 : 201).json({ ...sanitizeUser(user), reactivated: !!user.reactivated });
}));

router.patch("/users/:id/permissions", asyncHandler(async (req, res) => {
  const targetId = String(req.params.id || "");
  const permissions = req.body?.permissions;

  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return res.status(400).json({ error: "Permissões inválidas." });
  }

  if (targetId === String(req.user?.id || "")) {
    return res.status(400).json({ error: "As permissões do próprio administrador não podem ser alteradas por esta tela." });
  }

  const targetUser = await getUserById(targetId);
  if (!targetUser || targetUser.ativo === false) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }
  if (bloquearSeAlvoAdmin(req, res, targetUser)) return;

  // Permissões personalizadas são administradas somente por admin e não
  // permitem transformar o usuário em outro perfil — apenas telas.
  let user;
  try {
    user = await updateUserPermissions(targetId, permissions);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  await auditLog({
    user: req.user,
    action: "UPDATE_USER_PERMISSIONS",
    target: targetId,
    details: { usuario: targetUser.usuario, permissions: user.permissions }
  });

  emitEvent("users_updated", { action: "permissions_updated", user: sanitizeUser(user) });
  res.json(sanitizeUser(user));
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

  if (bloquearSeAlvoAdmin(req, res, userToDelete)) return;

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

  if (!senha) {
    return res.status(400).json({ error: "Senha é obrigatória." });
  }

  const targetUser = await getUserById(req.params.id);

  if (!targetUser || targetUser.ativo === false) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }
  if (bloquearSeAlvoAdmin(req, res, targetUser)) return;

  // updateUserPassword valida a força da senha (ver src/utils/passwordPolicy.js)
  // e lança erro com mensagem clara se não atender aos requisitos.
  try {
    await updateUserPassword(req.params.id, senha);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Senha trocada: derruba as sessões abertas do usuário afetado.
  await pool.query(
    `DELETE FROM auth_sessions WHERE user_data::jsonb->>'id' = $1`,
    [String(req.params.id)]
  );

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
