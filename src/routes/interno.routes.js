// Rotas internas entre os dois processos do servidor (painel e catálogo). Nunca públicas:
// exigem o segredo compartilhado (X-Interno-Token) e origem na rede interna.
const express = require("express");
const crypto = require("crypto");
const logger = require("../utils/logger");
const { ipPrivado } = require("../middlewares/catalogo-consulta");

const router = express.Router();

function tokenValido(recebido) {
  const esperado = process.env.INTERNO_TOKEN || process.env.API_TOKEN || "";
  const a = Buffer.from(String(recebido || ""));
  const b = Buffer.from(esperado);
  return b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post("/interno/recarregar", async (req, res) => {
  if (!ipPrivado(req.socket && req.socket.remoteAddress) || !tokenValido(req.get("x-interno-token"))) {
    return res.status(403).json({ error: "negado" });
  }
  const tipo = String((req.body && req.body.tipo) || "");
  try {
    if (tipo === "estoque") {
      await require("../services/estoque.service").carregarEstoque();
    } else if (tipo === "fotos") {
      require("../services/catalogo-fotos.service").recarregarDoDisco();
    } else if (tipo === "produtos") {
      require("../services/catalogo-x2.service").recarregarIndices();
      require("../services/catalogo-fotos.service").recarregarDoDisco();
      require("../services/catalogo-pdf.service").limparCacheBboxFotos();
    } else {
      return res.status(400).json({ error: "tipo inválido" });
    }
    logger.info(`[interno] cache recarregado a pedido do outro processo: ${tipo}`);
    return res.json({ ok: true, tipo });
  } catch (err) {
    logger.error(`[interno] falha ao recarregar ${tipo}: ${err.message}`);
    return res.status(500).json({ error: "falha ao recarregar" });
  }
});

module.exports = router;
