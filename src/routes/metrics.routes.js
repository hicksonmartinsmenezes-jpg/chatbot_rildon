const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const logger       = require("../utils/logger");
const { buscarMetricas } = require("../services/metrics.service");
const { gerarPdfMetricas } = require("../services/metrics-pdf.service");

const router = express.Router();

// 2026-09-16: aceita ?mes=YYYY-MM para filtrar as métricas do painel.
router.get("/metrics", asyncHandler(async (req, res) => {
  const mes = typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes)
    ? req.query.mes
    : null;
  const data = await buscarMetricas(mes);
  res.json(data);
}));

// Exporta o mesmo resumo do painel de Métricas em PDF.
router.get("/metrics/exportar-pdf", asyncHandler(async (req, res) => {
  const mes = typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes)
    ? req.query.mes
    : null;

  const data = await buscarMetricas(mes);

  try {
    const pdf = await gerarPdfMetricas(data);

    if (res.writableEnded || res.destroyed) return;

    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="metricas-${mes || Date.now()}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  } catch (err) {
    logger.error("❌ Erro ao exportar métricas em PDF:", err?.stack || err);
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ error: "Erro ao gerar PDF de métricas." });
    }
  }
}));

module.exports = router;
