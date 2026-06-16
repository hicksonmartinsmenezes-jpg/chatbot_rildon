const express    = require("express");
const { getUsers } = require("../services/user.service");

const router = express.Router();

router.get("/atendentes", async (req, res) => {
  try {
    const users  = await getUsers();
    const ativos = users
      .filter(u => u.ativo !== false)
      .map(u => ({
        id:     u.id,
        nome:   u.nome,
        perfil: u.perfil,
        sector: u.sector || "geral"
      }));
    res.json(ativos);
  } catch (err) {
    res.status(500).json([]);
  }
});

module.exports = router;
