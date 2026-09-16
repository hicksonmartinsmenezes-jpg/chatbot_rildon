const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const logger       = require("../utils/logger");
const { PassThrough } = require("stream");
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
// O PDF é montado em memória antes de tocar na resposta HTTP. Isso impede
// que um erro/encerramento antecipado da resposta deixe o PDFKit escrevendo
// em um ServerResponse já finalizado (ERR_STREAM_WRITE_AFTER_END).
router.get("/metrics/exportar-pdf", asyncHandler(async (req, res) => {
  const mes = typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes)
    ? req.query.mes
    : null;

  const data = await buscarMetricas(mes);

  try {
    const pdfStream = new PassThrough();
    const chunks = [];

    pdfStream.on("data", chunk => chunks.push(chunk));

    const pdfBuffer = await new Promise((resolve, reject) => {
      pdfStream.once("finish", () => resolve(Buffer.concat(chunks)));
      pdfStream.once("error", reject);

      try {
        gerarPdfMetricas(data, pdfStream);
      } catch (err) {
        reject(err);
      }
    });

    if (res.writableEnded || res.destroyed) return;

    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="metricas-${mes || Date.now()}.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (err) {
    logger.error("❌ Erro ao exportar métricas em PDF:", err?.stack || err);
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ error: "Erro ao gerar PDF de métricas." });
    }
  }
}));

module.exports = router;
