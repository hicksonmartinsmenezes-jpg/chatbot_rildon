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
router.get("/metrics/exportar-pdf", asyncHandler(async (req, res) => {
  try {
    const data = await buscarMetricas();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="metricas-${Date.now()}.pdf"`);
    gerarPdfMetricas(data, res);
  } catch (err) {
    logger.error("❌ Erro ao exportar métricas em PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Erro ao gerar PDF de métricas." });
  }
}));

module.exports = router;
