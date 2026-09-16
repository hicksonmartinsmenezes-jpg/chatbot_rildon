/**
 * Exportação do relatório de métricas.
 * Layout A4 compacto e orientado para impressão, mantendo o papel timbrado
 * e os dados já fornecidos por metrics.service.js.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const FUNDO_IMG = fs.readFileSync(path.join(__dirname, "../assets/metricas-papel-timbrado.png"));
const MARGIN = 36;
// Pedido do usuário (2026-09-16, com print do PDF real): título/subtítulo
// estavam desenhados em y=45/72 — dentro da faixa azul do papel timbrado
// (o "RILDON" do logo), sobrepondo o texto. A faixa azul + onda do papel
// timbrado só libera a partir de ~93pt (11% dos 841.89pt de altura do A4 —
// medido por pixel no arquivo fonte, ver metricas-papel-timbrado.png).
// TITULO_Y/SUBTITULO_Y ficam abaixo dessa linha; TOP (onde a 1ª faixa de
// conteúdo — "Resumo do mês" — começa) desce mais ainda, dando respiro
// depois do subtítulo em vez de colar em cima dele.
const TITULO_Y = 112;
const SUBTITULO_Y = 136;
const TOP = 168;
const BOTTOM = 48;
const AZUL = "#006097";
const AZUL_CLARO = "#eef5f9";
const AZUL_BORDA = "#d6e5ee";
const TEXTO = "#263238";
const SEC = "#66717b";
const LINHA = "#e3e8ec";
const CARD = "#ffffff";
const CINZA = "#f5f7f9";
const VERDE = "#16803c";
const VERMELHO = "#c62828";

const MESES_PT = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];

function _nomeMes(mesRef) {
  const [ano, mes] = String(mesRef).split("-").map(Number);
  return `${MESES_PT[mes - 1]}/${ano}`;
}

function _formatarMin(min) {
  if (min == null) return "sem dados";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

function _setaVariacao(pct) {
  if (pct == null) return "";
  if (pct === 0) return " (=)";
  return pct > 0 ? ` (+${pct}%)` : ` (${pct}%)`;
}

function _fundo(doc) {
  doc.image(FUNDO_IMG, 0, 0, { width: doc.page.width, height: doc.page.height });
}

function _cabecalho(doc, subtitulo) {
  const w = doc.page.width - MARGIN * 2;
  doc.fillColor("#000000").font("Helvetica-Bold").fontSize(18)
    .text("RELATÓRIO DE MÉTRICAS", MARGIN, TITULO_Y, { width: w, align: "center", lineBreak: false });
  doc.fillColor(SEC).font("Helvetica").fontSize(9)
    .text(subtitulo, MARGIN, SUBTITULO_Y, { width: w, align: "center", lineBreak: false });
}

function _rodape(doc, pagina) {
  doc.fillColor("#7a838b").font("Helvetica").fontSize(8)
    .text(`Página ${pagina}`, MARGIN, doc.page.height - BOTTOM, { width: doc.page.width - MARGIN * 2, align: "center", lineBreak: false });
}

function gerarPdfMetricas(data, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  doc.pipe(destino);

  const historico = !!data.mesRef;
  const agora = new Date();
  const geradoEm = agora.toLocaleDateString("pt-BR") + " " + agora.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const subtitulo = historico ? `Métricas de ${_nomeMes(data.mesRef)}  •  gerado em ${geradoEm}` : `Gerado em ${geradoEm}`;
  const janela = historico ? "no mês" : "últimos 30 dias";
  const gap = 8;

  function pagina(n) {
    doc.addPage();
    _fundo(doc);
    _cabecalho(doc, subtitulo);
    _rodape(doc, n);
  }

  function faixa(titulo, x, y, w) {
    doc.roundedRect(x, y, w, 22, 4).fillColor(AZUL_CLARO).fill();
    doc.fillColor(AZUL).font("Helvetica-Bold").fontSize(10.5)
      .text(titulo, x + 9, y + 6, { width: w - 18, lineBreak: false });
  }

  function cartao(x, y, w, h, titulo, valor, cor = TEXTO) {
    doc.roundedRect(x, y, w, h, 5).fillColor(CARD).fill().lineWidth(0.7).strokeColor(AZUL_BORDA).stroke();
    doc.fillColor(SEC).font("Helvetica").fontSize(7.8)
      .text(titulo, x + 9, y + 8, { width: w - 18, lineBreak: false });
    doc.fillColor(cor).font("Helvetica-Bold").fontSize(13)
      .text(String(valor), x + 9, y + 23, { width: w - 18, lineBreak: false });
  }

  function textoCab(x, y, w, texto, align = "left", size = 8) {
    doc.fillColor(SEC).font("Helvetica-Bold").fontSize(size)
      .text(String(texto), x, y, { width: w, align, lineBreak: false });
  }

  function textoCel(x, y, w, texto, align = "left", size = 8.2, bold = false) {
    doc.fillColor(TEXTO).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
      .text(String(texto ?? "—"), x, y, { width: w, align, lineBreak: false });
  }

  function tabela(x, y, w, colunas, frac, linhas, opts = {}) {
    const fs = opts.fonte || 8.2;
    const headH = opts.headH || 20;
    const rowH = opts.rowH || 18;
    let cx = x;
    doc.roundedRect(x, y, w, headH, 3).fillColor(CINZA).fill();
    colunas.forEach((c, i) => {
      const cw = w * frac[i];
      textoCab(cx + 5, y + 6, cw - 10, c, opts.align?.[i] || "left", fs);
      cx += cw;
    });
    let cy = y + headH;
    if (!linhas.length) {
      doc.fillColor("#8a939b").font("Helvetica-Oblique").fontSize(fs)
        .text("Sem dados ainda.", x + 6, cy + 5, { width: w });
      return cy + 18;
    }
    linhas.forEach((linha, idx) => {
      if (idx % 2) doc.rect(x, cy, w, rowH).fillColor("#fbfcfd").fill();
      cx = x;
      linha.forEach((v, i) => {
        const cw = w * frac[i];
        let valor = String(v ?? "—");
        doc.font("Helvetica").fontSize(fs);
        const limite = Math.max(8, cw - 10);
        if (doc.widthOfString(valor) > limite) {
          while (valor.length > 1 && doc.widthOfString(`${valor}…`) > limite) valor = valor.slice(0, -1);
          valor += "…";
        }
        textoCel(cx + 5, cy + 5, cw - 10, valor, opts.align?.[i] || "left", fs, false);
        cx += cw;
      });
      doc.moveTo(x, cy + rowH).lineTo(x + w, cy + rowH).lineWidth(0.35).strokeColor(LINHA).stroke();
      cy += rowH;
    });
    return cy;
  }

  // PÁGINA 1 — RESUMO E DISTRIBUIÇÕES
  pagina(1);
  // BUG CORRIGIDO (2026-09-16): "W" (largura útil da página) só pode ser lida
  // de doc.page DEPOIS do primeiro addPage() — o documento é criado com
  // autoFirstPage:false (ver construtor acima), então doc.page é null até a
  // primeira página existir. Calcular W antes de pagina(1) (como estava)
  // derrubava TODA chamada de gerarPdfMetricas com "Cannot read properties
  // of null (reading 'width')", com ou sem filtro de mês — essa é a causa
  // real por trás dos crashes reportados na exportação de métricas em PDF.
  const W = doc.page.width - MARGIN * 2;
  faixa("Resumo do mês", MARGIN, TOP, W);

  const cardW = (W - gap * 3) / 4;
  const cardH = 48;
  const cardsY = TOP + 30;
  const valores = [
    ["Atendimentos", `${data.mensal ?? 0}${_setaVariacao(data.tendencia?.totalVariacaoPct)}`],
    ["Em andamento", data.andamento ?? 0],
    ["Resolvidos", data.resolvidos ?? 0, VERDE],
    ["Cancelados", data.cancelados ?? 0, VERMELHO],
    ["Pendentes", data.pendentes ?? 0],
    ["Taxa de resolução", `${data.taxaResolucao ?? 0}%`],
    ["Horário de pico", data.horarioPico ? `${String(data.horarioPico.hora).padStart(2, "0")}h (${data.horarioPico.total})` : "sem dados"],
    ["Satisfação média", data.satisfacaoMedia != null ? `${Number(data.satisfacaoMedia).toFixed(1)} / 5` : "sem dados"],
    ["Tempo de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin) + _setaVariacao(data.tendencia?.tempoResolucaoVariacaoPct)],
    ["1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin) + _setaVariacao(data.tendencia?.tempoRespostaVariacaoPct)],
    ["Avaliações", data.satisfacaoTotalRespostas ?? 0],
    ["Janela", janela]
  ];
  valores.forEach((v, i) => cartao(MARGIN + (i % 4) * (cardW + gap), cardsY + Math.floor(i / 4) * (cardH + gap), cardW, cardH, v[0], v[1], v[2] || TEXTO));

  const blocoY = cardsY + 3 * (cardH + gap) + 12;
  const colW = (W - gap) / 2;

  faixa("Comparação com o mês anterior", MARGIN, blocoY, colW);
  const compFim = tabela(MARGIN, blocoY + 27, colW, ["Métrica", "Atual", "Anterior", "Var."], [0.44, 0.19, 0.21, 0.16], [
    ["Atendimentos", data.mensal ?? 0, data.tendencia?.totalMesAnterior ?? 0, data.tendencia?.totalVariacaoPct != null ? `${data.tendencia.totalVariacaoPct > 0 ? "+" : ""}${data.tendencia.totalVariacaoPct}%` : "—"],
    ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`, `${data.tendencia?.taxaResolucaoMesAnterior ?? 0}%`, data.tendencia?.taxaResolucaoVariacaoPontos != null ? `${data.tendencia.taxaResolucaoVariacaoPontos > 0 ? "+" : ""}${data.tendencia.taxaResolucaoVariacaoPontos}pp` : "—"],
    ["Tempo de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), _formatarMin(data.tendencia?.tempoResolucaoAnteriorMin), data.tendencia?.tempoResolucaoVariacaoPct != null ? `${data.tendencia.tempoResolucaoVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoResolucaoVariacaoPct}%` : "—"],
    ["1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin), _formatarMin(data.tendencia?.tempoRespostaAnteriorMin), data.tendencia?.tempoRespostaVariacaoPct != null ? `${data.tendencia.tempoRespostaVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoRespostaVariacaoPct}%` : "—"]
  ], { align: ["left", "right", "right", "right"] });

  const x2 = MARGIN + colW + gap;
  faixa("Distribuição de notas de satisfação", x2, blocoY, colW);
  tabela(x2, blocoY + 27, colW, ["Nota", "Avaliações"], [0.55, 0.45], [5, 4, 3, 2, 1].map(n => [`Nota ${n}`, data.distribuicaoNotas?.[n] ?? 0]), { align: ["left", "right"] });

  const baixoY = Math.max(compFim, blocoY + 27 + 20 + 5 * 18) + 12;
  faixa(`Atendimentos por setor (${janela})`, MARGIN, baixoY, colW);
  const setores = Object.entries(data.porSetor || {}).sort((a, b) => b[1] - a[1]);
  tabela(MARGIN, baixoY + 27, colW, ["Setor", "Atendimentos"], [0.68, 0.32], setores.map(([s, n]) => [s, n]), { align: ["left", "right"] });

  faixa("Atendentes", x2, baixoY, colW);
  if (historico) {
    tabela(x2, baixoY + 27, colW, ["Atendente", "Mês", "Histórico", "Agora"], [0.38, 0.16, 0.22, 0.24], (data.atendentes || []).map(a => [a.nome, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]), { align: ["left", "right", "right", "right"], fonte: 7.8 });
  } else {
    tabela(x2, baixoY + 27, colW, ["Atendente", "Hoje", "7d", "Mês", "Hist.", "Agora"], [0.28, 0.13, 0.11, 0.13, 0.18, 0.17], (data.atendentes || []).map(a => [a.nome, a.atendidosHoje, a.atendidosSemana, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]), { align: ["left", "right", "right", "right", "right", "right"], fonte: 7.1 });
  }

  // PÁGINA 2 — SATISFAÇÃO DETALHADA
  pagina(2);
  faixa("Satisfação por atendente", MARGIN, TOP, W);
  const sat = Object.entries(data.satisfacaoPorAtendente || {}).sort((a, b) => b[1].media - a[1].media);
  const satFim = tabela(MARGIN, TOP + 27, W, ["Atendente", "Média", "Avaliações"], [0.58, 0.21, 0.21], sat.map(([nome, v]) => [nome, `${Number(v.media || 0).toFixed(1)} / 5`, v.total]), { align: ["left", "right", "right"] });

  const feedbackY = satFim + 16;
  faixa("O que os clientes disseram (notas 1–2, mais recentes)", MARGIN, feedbackY, W);
  const feedbacks = (data.feedbacksNegativos || []).slice(0, 15);
  const ty = feedbackY + 27;
  const cols = [0.16, 0.20, 0.09, 0.55];
  const heads = ["Protocolo", "Cliente", "Nota", "Comentário"];
  const tw = W;
  const hh = 20;
  doc.roundedRect(MARGIN, ty, tw, hh, 3).fillColor(CINZA).fill();
  let cx = MARGIN;
  heads.forEach((h, i) => { const cw = tw * cols[i]; textoCab(cx + 5, ty + 6, cw - 10, h, "left", 8); cx += cw; });
  let fy = ty + hh;
  if (!feedbacks.length) {
    doc.fillColor("#8a939b").font("Helvetica-Oblique").fontSize(9).text("Sem dados ainda.", MARGIN + 6, fy + 5, { width: tw });
  } else {
    feedbacks.forEach((f, i) => {
      doc.font("Helvetica").fontSize(8.1);
      const comentario = String(f.feedback || "Sem comentário");
      const comentarioW = tw * cols[3] - 10;
      const alturaTexto = doc.heightOfString(comentario, { width: comentarioW, lineGap: 1 });
      const h = Math.min(42, Math.max(20, alturaTexto + 8));
      if (i % 2) doc.rect(MARGIN, fy, tw, h).fillColor("#fbfcfd").fill();
      cx = MARGIN;
      [
        `#${f.protocolo}`,
        f.customerName || "Não informado",
        `${f.rating}/5`
      ].forEach((v, j) => {
        const cw = tw * cols[j];
        textoCel(cx + 5, fy + 6, cw - 10, v, "left", 8.1);
        cx += cw;
      });
      doc.fillColor(TEXTO).font("Helvetica").fontSize(8.1)
        .text(comentario, cx + 5, fy + 5, { width: comentarioW, height: h - 6, lineGap: 1, ellipsis: true });
      doc.moveTo(MARGIN, fy + h).lineTo(MARGIN + tw, fy + h).lineWidth(0.35).strokeColor(LINHA).stroke();
      fy += h;
    });
  }

  doc.end();
}

module.exports = { gerarPdfMetricas };
