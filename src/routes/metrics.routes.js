const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const logger       = require("../utils/logger");
const { PassThrough } = require("stream");
const { buscarMetricas } = require("../services/metrics.service");
const { gerarPdfMetricas } = require("../services/metrics-pdf.service");

const router = express.Router();

// Timezone de negócio — mesma convenção de metrics.service.js.
const TZ = process.env.TZ_NEGOCIO || "America/Maceio";

/**
 * "YYYY-MM" do mês corrente NO FUSO DE NEGÓCIO (não no fuso do servidor
 * Node, que pode estar em UTC no container e virar o mês algumas horas
 * antes/depois). Usa Intl em vez de getMonth() justamente por isso.
 */
function _mesCorrente() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" })
      .formatToParts(new Date())
      .map(p => [p.type, p.value])
  );
  return `${partes.year}-${partes.month}`;
}

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
  // Auditoria 2026-09-17 (pedido do usuário: "verifique todos os dados se
  // batem perfeitamente"): quando o seletor de mês ficava vazio, o PDF era
  // gerado com mesRef=null — e nesse modo satisfação/notas/feedbacks são
  // ACUMULADOS (desde sempre) e horário de pico é dos ÚLTIMOS 30 DIAS,
  // enquanto os cards de cima (Atendimentos/Resolvidos/Taxa/TMA/TME) já
  // eram do mês. Resultado provado num Postgres de teste: card
  // "Avaliações" = 5 (desde sempre) contra a linha "Avaliações/Este mês"
  // = 2 na tabela ao lado, e a legenda "N atendimentos no mês" do horário
  // de pico mostrando a contagem de 30 dias corridos.
  //
  // Correção: o RELATÓRIO sempre tem um mês de referência. Sem ?mes=, usa
  // o mês corrente (no fuso de negócio) em vez de null — assim TODA query
  // usa o mesmo recorte e o PDF fica internamente consistente. O painel ao
  // vivo (GET /metrics acima) continua aceitando null e se comportando
  // exatamente como antes; só a exportação mudou.
  const mes = typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes)
    ? req.query.mes
    : _mesCorrente();

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
    const detalhe = err?.stack || err?.message || String(err);
    logger.error(`❌ Erro ao exportar métricas em PDF: ${detalhe}`);
    if (!res.headersSent && !res.writableEnded) {
      res.status(500).json({ error: "Erro ao gerar PDF de métricas." });
    }
  }
}));

module.exports = router;
