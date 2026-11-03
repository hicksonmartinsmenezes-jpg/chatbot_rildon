// Rotas internas entre os dois processos (painel e o serviço catalogo-rildon,
// repositório próprio desde 2026-11-03). Nunca públicas: exigem o segredo
// compartilhado (X-Interno-Token) e origem na rede interna.
const express = require("express");
const crypto = require("crypto");
const net = require("net");
const logger = require("../utils/logger");

const router = express.Router();

// Mesma função usada pelo catalogo-rildon (src/middlewares/catalogo-consulta.js)
// — duplicada aqui de propósito, igual outros utilitários pequenos
// compartilhados entre os dois repositórios (ver CLAUDE.md).
function ipPrivado(ip) {
  let v = String(ip || "").replace(/^::ffff:/i, "");
  if (net.isIPv6(v)) return v === "::1" || /^f[cd][0-9a-f]{2}:/i.test(v);
  if (!net.isIPv4(v)) return false;
  const [a, b] = v.split(".").map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

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
      // Sem efeito aqui: o painel não mantém cache de fotos/PDF (isso agora
      // vive só em catalogo-rildon) — só confirma recebido pro outro lado
      // não ficar reenviando.
    } else if (tipo === "produtos") {
      require("../services/catalogo-x2.service").recarregarIndices();
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
