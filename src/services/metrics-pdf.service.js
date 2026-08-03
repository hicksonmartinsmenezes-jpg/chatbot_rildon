/**
 * metrics-pdf.service.js — exporta o resumo do painel de Métricas em PDF
 * (pedido do usuário, 2026-07-31, mesma ideia já aprovada pro Catálogo — ver
 * catalogo-pdf.service.js). Reaproveita o mesmo cabeçalho/rodapé de marca
 * (src/assets/catalogo-cabecalho.png / catalogo-rodape.png) pra manter a
 * identidade visual consistente entre os dois PDFs exportáveis do painel.
 *
 * Ao contrário do catálogo (grid de fotos, paginação por produto), aqui é
 * um relatório de texto/tabelas — layout mais simples: título + seções, cada
 * uma com uma tabelinha (linhas de texto), quebrando de página sozinho
 * quando o conteúdo passa do rodapé.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const RODAPE_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-rodape.png"));
const RODAPE_IMG_RATIO = 1372 / 156;
const CABECALHO_IMG = fs.readFileSync(path.join(__dirname, "../assets/catalogo-cabecalho.png"));
const CABECALHO_IMG_RATIO = 719 / 146;
const CABECALHO_SANGRIA_TOPO = 16;
const RODAPE_NUM_X_FRACAO = 1062 / 1372;
const RODAPE_NUM_Y_FRACAO = 108 / 156;

const PAGE_MARGIN = 36;
const CABECALHO_IMG_ALTURA_REAL = 595.28 / CABECALHO_IMG_RATIO;
const HEADER_HEIGHT = CABECALHO_IMG_ALTURA_REAL - CABECALHO_SANGRIA_TOPO;
const FOOTER_HEIGHT = 595.28 / RODAPE_IMG_RATIO;
const TITULO_GAP_TOPO = 8;
const TITULO_FONTE = "Helvetica-Bold";
const TITULO_TAMANHO = 17;
const SUBTITULO_FONTE = "Helvetica";
const SUBTITULO_TAMANHO = 10;

const AZUL = "#006097";
const VERMELHO_CATEGORIA = "#dc2626";
const CINZA_TEXTO = "#374151";
const CINZA_LINHA = "#e5e7eb";
const VERDE = "#16a34a";
const VERMELHO = "#dc2626";

function _desenharCabecalho(doc, subtitulo) {
  const w = doc.page.width;
  doc.image(CABECALHO_IMG, 0, -CABECALHO_SANGRIA_TOPO, { width: w, height: CABECALHO_IMG_ALTURA_REAL });

  const tituloY = HEADER_HEIGHT + TITULO_GAP_TOPO;
  doc.fillColor("#000000", 0.35).font(TITULO_FONTE).fontSize(TITULO_TAMANHO)
    .text("RELATÓRIO DE MÉTRICAS", PAGE_MARGIN + 1.5, tituloY + 1.5, { width: w - PAGE_MARGIN * 2 });
  doc.fillOpacity(1);
  doc.fillColor(VERMELHO_CATEGORIA).font(TITULO_FONTE).fontSize(TITULO_TAMANHO)
    .text("RELATÓRIO DE MÉTRICAS", PAGE_MARGIN, tituloY, { width: w - PAGE_MARGIN * 2 });

  doc.fillColor(CINZA_TEXTO).font(SUBTITULO_FONTE).fontSize(SUBTITULO_TAMANHO)
    .text(subtitulo, PAGE_MARGIN, tituloY + TITULO_TAMANHO + 6, { width: w - PAGE_MARGIN * 2 });

  doc.fillColor("#111827").font("Helvetica");
}

function _desenharRodape(doc, numeroPagina) {
  const w = doc.page.width;
  const h = doc.page.height;
  doc.image(RODAPE_IMG, 0, h - FOOTER_HEIGHT, { width: w, height: FOOTER_HEIGHT });

  const footerTop = h - FOOTER_HEIGHT;
  const centroX = w * RODAPE_NUM_X_FRACAO;
  const centroY = footerTop + FOOTER_HEIGHT * RODAPE_NUM_Y_FRACAO;
  const fonteNumero = 16;
  const larguraCaixa = 70;
  const alturaLinhaAprox = fonteNumero * 1.3;
  const yMaximo = h - alturaLinhaAprox - 2;
  const yTexto = Math.min(centroY - fonteNumero / 2, yMaximo);

  doc.fillColor("#111827").font("Helvetica-Bold").fontSize(fonteNumero)
    .text(String(numeroPagina), centroX - larguraCaixa / 2, yTexto, { width: larguraCaixa, align: "center", lineBreak: false });

  doc.fillColor("#111827").font("Helvetica");
}

function _formatarMin(min) {
  if (min == null) return "sem dados";
  if (min < 60) return `${Math.round(min)} min`;
  const horas = Math.floor(min / 60);
  const resto = Math.round(min % 60);
  return resto > 0 ? `${horas}h${String(resto).padStart(2, "0")}` : `${horas}h`;
}

function _setaVariacao(pct) {
  if (pct == null) return "";
  if (pct === 0) return " (=)";
  return pct > 0 ? ` (+${pct}%)` : ` (${pct}%)`;
}

/**
 * Gera o PDF e faz stream direto pro destino (a `res` do Express — quem
 * chama já seta os headers de Content-Type/Content-Disposition antes).
 */
function gerarPdfMetricas(data, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false, bufferPages: true });
  doc.pipe(destino);

  let pagina = 0;
  const areaFimY = () => doc.page.height - FOOTER_HEIGHT - 12;
  const larguraUtil = () => doc.page.width - PAGE_MARGIN * 2;

  const agora = new Date();
  const dataFmt = agora.toLocaleDateString("pt-BR") + " " + agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  function novaPagina() {
    doc.addPage();
    pagina += 1;
    _desenharCabecalho(doc, `Gerado em ${dataFmt}`);
    _desenharRodape(doc, pagina);
    doc.y = HEADER_HEIGHT + TITULO_GAP_TOPO + TITULO_TAMANHO + SUBTITULO_TAMANHO + 24;
  }

  // Garante espaço mínimo antes de desenhar algo — quebra de página sozinho
  // se não sobrar altura suficiente (mesmo princípio do catalogo-pdf.service.js).
  function garantirEspaco(alturaNecessaria) {
    if (doc.y + alturaNecessaria > areaFimY()) novaPagina();
  }

  function tituloSecao(texto) {
    garantirEspaco(30);
    doc.moveDown(0.6);
    doc.fillColor(AZUL).font("Helvetica-Bold").fontSize(13).text(texto, PAGE_MARGIN, doc.y, { width: larguraUtil() });
    doc.moveTo(PAGE_MARGIN, doc.y + 2).lineTo(PAGE_MARGIN + larguraUtil(), doc.y + 2)
      .lineWidth(1).strokeColor(AZUL, 0.5).stroke();
    doc.moveDown(0.5);
    doc.fillColor("#111827").font("Helvetica");
  }

  // Linha "rótulo .......... valor" — usada nos KPIs em texto corrido.
  function linhaKpi(rotulo, valor, corValor = "#111827") {
    garantirEspaco(18);
    const y = doc.y;
    doc.fillColor(CINZA_TEXTO).font("Helvetica").fontSize(10.5)
      .text(rotulo, PAGE_MARGIN, y, { width: larguraUtil() * 0.62, continued: false });
    doc.fillColor(corValor).font("Helvetica-Bold").fontSize(10.5)
      .text(String(valor), PAGE_MARGIN + larguraUtil() * 0.62, y, { width: larguraUtil() * 0.38, align: "right" });
    doc.y = y + 16;
  }

  // Trunca manualmente pra caber em `largura`, usando a fonte/tamanho JÁ
  // ativos em `doc` no momento da chamada. Existe porque `lineBreak: false`
  // do pdfkit NÃO garante uma linha só: se o texto for mais largo que a
  // caixa, ele quebra em 2 linhas mesmo assim (bug encontrado 2026-07-31 —
  // reproduzido isolado: "#20260731-0001" mede ~71.8pt de largura real, mas
  // a coluna Protocolo só tinha 70.49pt de espaço útil — 1.3pt faltando já
  // bastava pra quebrar a linha, mesmo com lineBreak:false E ellipsis:true).
  // Solução: medir com doc.widthOfString ANTES de desenhar e cortar com "…"
  // até caber garantidamente, em vez de confiar no comportamento do pdfkit.
  function _ajustarLargura(texto, largura) {
    if (doc.widthOfString(texto) <= largura) return texto;
    let lo = 0, hi = texto.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidato = texto.slice(0, mid) + "…";
      if (doc.widthOfString(candidato) <= largura) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? texto.slice(0, lo) + "…" : "…";
  }

  // Tabela genérica: array de larguras relativas (soma = 1) + linhas de
  // strings. Cabeçalho em negrito com fundo leve; linhas com separador fino.
  function tabela(colunas, larguras, linhas) {
    garantirEspaco(22 + linhas.length * 16);
    const w = larguraUtil();
    const xs = [];
    let acc = PAGE_MARGIN;
    for (const frac of larguras) { xs.push(acc); acc += w * frac; }

    // Cabeçalho
    const yHead = doc.y;
    doc.rect(PAGE_MARGIN, yHead, w, 18).fillColor("#f3f4f6").fill();
    doc.fillColor("#374151").font("Helvetica-Bold").fontSize(9);
    colunas.forEach((col, i) => {
      const largura = w * larguras[i] - 8;
      doc.text(_ajustarLargura(col, largura), xs[i] + 4, yHead + 4, { width: largura, lineBreak: false });
    });
    doc.y = yHead + 18;

    doc.font("Helvetica").fontSize(9.5).fillColor("#111827");
    for (const linha of linhas) {
      garantirEspaco(16);
      const y = doc.y;
      linha.forEach((valor, i) => {
        const largura = w * larguras[i] - 8;
        doc.text(_ajustarLargura(String(valor ?? "—"), largura), xs[i] + 4, y + 3, { width: largura, lineBreak: false });
      });
      doc.moveTo(PAGE_MARGIN, y + 15.5).lineTo(PAGE_MARGIN + w, y + 15.5)
        .lineWidth(0.5).strokeColor(CINZA_LINHA, 0.8).stroke();
      doc.y = y + 16;
    }
    if (!linhas.length) {
      doc.fillColor("#9ca3af").font("Helvetica-Oblique").fontSize(9.5)
        .text("Sem dados ainda.", PAGE_MARGIN, doc.y + 3, { width: w });
      doc.y += 16;
      doc.font("Helvetica").fillColor("#111827");
    }
  }

  novaPagina();

  // ── Resumo do mês ──────────────────────────────────────────────────────
  tituloSecao("Resumo do mês");
  linhaKpi("Total de atendimentos (mês)", data.mensal + _setaVariacao(data.tendencia?.totalVariacaoPct));
  linhaKpi("Em andamento agora", data.andamento);
  linhaKpi("Resolvidos", data.resolvidos, VERDE);
  linhaKpi("Cancelados", data.cancelados, VERMELHO);
  linhaKpi("Pendentes", data.pendentes);
  linhaKpi("Tickets hoje", data.hoje);
  linhaKpi("Taxa de resolução", `${data.taxaResolucao}%`);
  linhaKpi("Horário de pico (últimos 30 dias)", data.horarioPico ? `${String(data.horarioPico.hora).padStart(2, "0")}h (${data.horarioPico.total} atendimentos)` : "sem dados");
  linhaKpi("Tempo médio de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin) + _setaVariacao(data.tendencia?.tempoResolucaoVariacaoPct));
  linhaKpi("Tempo médio até 1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin) + _setaVariacao(data.tendencia?.tempoRespostaVariacaoPct));
  linhaKpi("Satisfação média", data.satisfacaoMedia != null ? `${data.satisfacaoMedia.toFixed(1)} / 5 (${data.satisfacaoTotalRespostas} avaliações)` : "sem avaliações ainda");

  // ── Comparação com o mês anterior ──────────────────────────────────────
  tituloSecao("Comparação com o mês anterior");
  tabela(
    ["Métrica", "Mês atual", "Mês anterior", "Variação"],
    [0.40, 0.20, 0.20, 0.20],
    [
      ["Total de atendimentos", data.mensal, data.tendencia?.totalMesAnterior ?? 0, data.tendencia?.totalVariacaoPct != null ? `${data.tendencia.totalVariacaoPct > 0 ? "+" : ""}${data.tendencia.totalVariacaoPct}%` : "—"],
      // BUG CORRIGIDO (2026-07-31): comparava `data.taxaResolucao` (taxa
      // ACUMULADA desde sempre) contra `taxaResolucaoMesAnterior` (só mês
      // passado) — maçãs com laranjas, a acumulada mal se move mês a mês.
      // Agora as duas pontas são do mesmo tipo (mês atual vs mês anterior),
      // com variação em PONTOS percentuais (pp), não % da % (ver
      // metrics.service.js/taxaResolucaoVariacaoPontos).
      ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`, `${data.tendencia?.taxaResolucaoMesAnterior ?? 0}%`, data.tendencia?.taxaResolucaoVariacaoPontos != null ? `${data.tendencia.taxaResolucaoVariacaoPontos > 0 ? "+" : ""}${data.tendencia.taxaResolucaoVariacaoPontos}pp` : "—"],
      ["Tempo médio de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), _formatarMin(data.tendencia?.tempoResolucaoAnteriorMin), data.tendencia?.tempoResolucaoVariacaoPct != null ? `${data.tendencia.tempoResolucaoVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoResolucaoVariacaoPct}%` : "—"],
      ["Tempo médio até 1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin), _formatarMin(data.tendencia?.tempoRespostaAnteriorMin), data.tendencia?.tempoRespostaVariacaoPct != null ? `${data.tendencia.tempoRespostaVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoRespostaVariacaoPct}%` : "—"]
    ]
  );

  // ── Distribuição de notas ──────────────────────────────────────────────
  tituloSecao("Distribuição de notas de satisfação");
  const notas = data.distribuicaoNotas || {};
  tabela(
    ["Nota", "Quantidade de avaliações"],
    [0.5, 0.5],
    [5, 4, 3, 2, 1].map(n => [`Nota ${n}`, notas[n] ?? 0])
  );

  // ── Atendimentos por setor ─────────────────────────────────────────────
  tituloSecao("Atendimentos por setor (últimos 30 dias)");
  const setores = Object.entries(data.porSetor || {}).sort((a, b) => b[1] - a[1]);
  tabela(["Setor", "Atendimentos"], [0.7, 0.3], setores.map(([setor, total]) => [setor, total]));

  // ── Atendentes ──────────────────────────────────────────────────────────
  tituloSecao("Atendentes");
  tabela(
    ["Atendente", "Hoje", "7 dias", "Mês", "Total histórico", "Em atendimento"],
    [0.30, 0.12, 0.12, 0.12, 0.19, 0.15],
    (data.atendentes || []).map(a => [
      a.nome, a.atendidosHoje, a.atendidosSemana, a.atendidosMes, a.totalAtendidos, a.emAtendimento ? "Sim" : "—"
    ])
  );

  // ── Satisfação por atendente ────────────────────────────────────────────
  tituloSecao("Satisfação por atendente");
  const satisfacaoAtendentes = Object.entries(data.satisfacaoPorAtendente || {}).sort((a, b) => b[1].media - a[1].media);
  tabela(
    ["Atendente", "Média", "Avaliações"],
    [0.5, 0.25, 0.25],
    satisfacaoAtendentes.map(([nome, v]) => [nome, `${v.media.toFixed(1)} / 5`, v.total])
  );

  // ── Comentários negativos recentes ─────────────────────────────────────
  tituloSecao("O que os clientes disseram (notas 1-2, mais recentes)");
  const feedbacks = (data.feedbacksNegativos || []).slice(0, 20);
  tabela(
    ["Protocolo", "Cliente", "Nota", "Comentário"],
    [0.18, 0.22, 0.10, 0.50],
    feedbacks.map(f => [`#${f.protocolo}`, f.customerName || "Não informado", `${f.rating}/5`, (f.feedback || "").slice(0, 90)])
  );

  doc.end();
}

module.exports = { gerarPdfMetricas };
