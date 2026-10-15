const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const logger       = require("../utils/logger");
const { PassThrough } = require("stream");
const { buscarMetricas, listarAtendimentosDoPeriodo } = require("../services/metrics.service");
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

/** "YYYY-MM" válido na query, ou null. */
function _mesDaQuery(req) {
  return typeof req.query.mes === "string" && /^\d{4}-\d{2}$/.test(req.query.mes) ? req.query.mes : null;
}

/**
 * Intervalo livre ?de=YYYY-MM-DD&ate=YYYY-MM-DD (pedido do usuário
 * 2026-10-15) — só vale quando as DUAS datas vêm e estão na ordem certa;
 * caso contrário o recorte continua sendo por mês, como sempre foi.
 */
function _intervaloDaQuery(req) {
  const ok = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const { de, ate } = req.query;
  return ok(de) && ok(ate) && de <= ate ? { de, ate } : null;
}

/** Sufixo de nome de arquivo: "2026-09" ou "2026-09-01_a_2026-09-15". */
function _rotuloPeriodo(mes, intervalo) {
  if (intervalo) return `${intervalo.de}_a_${intervalo.ate}`;
  return mes || _mesCorrente();
}

// 2026-09-16: aceita ?mes=YYYY-MM para filtrar as métricas do painel.
// 2026-10-15: aceita também ?de=&ate= (intervalo livre).
router.get("/metrics", asyncHandler(async (req, res) => {
  const intervalo = _intervaloDaQuery(req);
  const data = await buscarMetricas(intervalo ? intervalo : _mesDaQuery(req));
  res.json(data);
}));

/**
 * Exportação dos atendimentos do período em CSV (pedido do usuário
 * 2026-10-15: até aqui só contatos e catálogo tinham exportação, e não havia
 * jeito de levar os atendimentos pra planilha).
 * Separador ";" e BOM UTF-8 porque é o que o Excel em português abre direto,
 * sem passar pelo assistente de importação.
 */
router.get("/metrics/exportar-csv", asyncHandler(async (req, res) => {
  const intervalo = _intervaloDaQuery(req);
  const mes = _mesDaQuery(req);
  const atendente = typeof req.query.atendente === "string" && /^[0-9a-f-]{36}$/i.test(req.query.atendente)
    ? req.query.atendente
    : null;

  const linhas = await listarAtendimentosDoPeriodo({
    mes: intervalo ? null : (mes || _mesCorrente()),
    de: intervalo?.de,
    ate: intervalo?.ate,
    atendente
  });

  const COLUNAS = [
    ["protocolo", "Protocolo"], ["cliente", "Cliente"], ["contato", "Contato"],
    ["tipo", "Tipo"], ["setor", "Setor"], ["status", "Status"], ["atendente", "Atendente"],
    ["aberto_em", "Aberto em"], ["assumido_em", "Assumido em"], ["fechado_em", "Fechado em"],
    ["espera_min", "Espera ate 1a resposta (min)"], ["duracao_min", "Duracao (min)"],
    ["nota", "Nota"], ["comentario", "Comentario"]
  ];

  // Previne fórmula sendo executada ao abrir no Excel (mesmo cuidado do
  // export de contatos, ver sanitizeCsvCell em contact.routes.js).
  const celula = (valor) => {
    let v = valor == null ? "" : String(valor);
    if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
    return `"${v.replace(/"/g, '""')}"`;
  };

  const csv = [
    COLUNAS.map(c => celula(c[1])).join(";"),
    ...linhas.map(l => COLUNAS.map(c => celula(l[c[0]])).join(";"))
  ].join("\r\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="atendimentos-${_rotuloPeriodo(mes, intervalo)}.csv"`);
  res.send(`\uFEFF${csv}`);
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
  const intervalo = _intervaloDaQuery(req);
  const mes = _mesDaQuery(req) || _mesCorrente();

  const data = await buscarMetricas(intervalo ? intervalo : mes);

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
    res.setHeader("Content-Disposition", `attachment; filename="metricas-${_rotuloPeriodo(mes, intervalo)}.pdf"`);
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
