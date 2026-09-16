const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const logger       = require("../utils/logger");
const { buscarMetricas } = require("../services/metrics.service");
const { gerarPdfMetricas } = require("../services/metrics-pdf.service");

const router = express.Router();

router.get("/metrics", asyncHandler(async (req, res) => {
  const data = await buscarMetricas();
  res.json(data);
}));

// Pedido do usuário (2026-07-31): exportar o mesmo resumo do painel de
// Métricas em PDF (mesma ideia já aprovada pro Catálogo — ver
// catalogo-pdf.service.js) pra imprimir/mandar pra alguém. Reaproveita
// buscarMetricas() — os números do PDF são exatamente os mesmos que o
// painel mostra na hora, sem duplicar nenhuma query.
//
// 2026-09-16 (pedido do usuário: "quero apenas exportar métricas do mês
// anterior não tenho opção disso"): aceita ?mes=YYYY-MM opcional — sem
// isso, continua exportando o mês corrente (comportamento de sempre). Valor
// fora do formato esperado é tratado como "não informado" em vez de erro
// 400 — mais tolerante a um querystring malformado, cai de volta pro mês
// corrente sozinho.
router.get("/metrics/exportar-pdf", asyncHandler(async (req, res) => {
  try {
    const mes = typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes)
      ? req.query.mes
      : null;
    const data = await buscarMetricas(mes);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="metricas-${mes || Date.now()}.pdf"`);
    gerarPdfMetricas(data, res);
  } catch (err) {
    logger.error("❌ Erro ao exportar métricas em PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF de métricas." });
  }
}));

module.exports = router;
