const express = require("express");

const {
  getUsers,
  createUser,
  updateUserPassword,
  deactivateUser
} = require("../services/user.service");

const { auditLog } = require("../services/audit.service");
const { requireRole } = require("./auth.routes");

const router = express.Router();

function sanitizeUser(user) {
  return {
    id: user.id,
    nome: user.nome,
    usuario: user.usuario,
    perfil: user.perfil,
    sector: user.sector || "geral",
    numero: user.numero || "",
    foto: user.foto || "",
    ativo: user.ativo
  };
}

router.get("/users", requireRole("admin"), async (req, res) => {
  const users = await getUsers();
  res.json(users.map(sanitizeUser));
});

router.post("/users", requireRole("admin"), async (req, res) => {
  try {
    const { nome, usuario, senha, perfil, sector, ativo } = req.body || {};

    if (!nome || !usuario || !senha) {
      return res.status(400).json({
        error: "Nome, usuário e senha são obrigatórios."
      });
    }

    const user = await createUser({
      nome,
      usuario,
      senha,
      perfil,
      sector,
      ativo
    });

    await auditLog({
      user: req.user,
      action: "CREATE_USER",
      target: user.id,
      details: {
        nome: user.nome,
        usuario: user.usuario,
        perfil: user.perfil,
        sector: user.sector
      }
    });

    res.status(201).json(sanitizeUser(user));

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

router.delete("/users/:id", requireRole("admin"), async (req, res) => {
  try {
    const users = await getUsers();

    const userToDelete = users.find(
      user => user.id === req.params.id
    );

    if (!userToDelete) {
      return res.status(404).json({
        error: "Usuário não encontrado."
      });
    }

    await deactivateUser(req.params.id);

    await auditLog({
      user: req.user,
      action: "DELETE_USER",
      target: userToDelete.id,
      details: {
        nome: userToDelete.nome,
        usuario: userToDelete.usuario,
        perfil: userToDelete.perfil
      }
    });

    res.json({ ok: true });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

router.patch("/users/:id/password", requireRole("admin"), async (req, res) => {
  try {
    const { senha } = req.body || {};

    if (!senha || senha.length < 4) {
      return res.status(400).json({
        error: "A senha deve ter pelo menos 4 caracteres."
      });
    }

    const users = await getUsers();

    const targetUser = users.find(
      user => user.id === req.params.id
    );

    await updateUserPassword(req.params.id, senha);

    await auditLog({
      user: req.user,
      action: "RESET_PASSWORD",
      target: req.params.id,
      details: {
        usuario: targetUser?.usuario || "desconhecido"
      }
    });

    res.json({ ok: true });

  } catch (error) {
    res.status(400).json({
      error: error.message
    });
  }
});

module.exports = router;