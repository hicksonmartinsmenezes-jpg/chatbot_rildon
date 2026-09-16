/**
 * Exporta o relatório de métricas em PDF.
 * Layout pensado para A4: cabeçalho centralizado, blocos bem espaçados,
 * tabelas compactas e quebra de página controlada.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const FUNDO_IMG = fs.readFileSync(path.join(__dirname, "../assets/metricas-papel-timbrado.png"));

const PAGE_MARGIN = 42;
const HEADER_HEIGHT = 100;
const FOOTER_HEIGHT = 55;
const TITULO_TAMANHO = 18;
const SUBTITULO_TAMANHO = 9.5;
const AZUL = "#006097";
const AZUL_CLARO = "#eef5f9";
const CINZA_TEXTO = "#374151";
const CINZA_LINHA = "#e5e7eb";
const CINZA_CABECALHO = "#f3f6f8";
const VERDE = "#16a34a";
const VERMELHO = "#dc2626";

const MESES_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

function _nomeMes(mesRef) {
  const [ano, mes] = mesRef.split("-").map(Number);
  return `${MESES_PT[mes - 1]}/${ano}`;
}

function _desenharFundo(doc) {
  doc.image(FUNDO_IMG, 0, 0, {
    width: doc.page.width,
    height: doc.page.height
  });
}

function _desenharCabecalho(doc, subtitulo) {
  const w = doc.page.width;
  const largura = w - PAGE_MARGIN * 2;
  const tituloY = HEADER_HEIGHT + 8;

  // Título centralizado na página, sem efeito/sombra.
  doc.fillColor("#000000")
    .font("Helvetica-Bold")
    .fontSize(TITULO_TAMANHO)
    .text("RELATÓRIO DE MÉTRICAS", PAGE_MARGIN, tituloY, {
      width: largura,
      align: "center",
      lineBreak: false
    });

  doc.fillColor(CINZA_TEXTO)
    .font("Helvetica")
    .fontSize(SUBTITULO_TAMANHO)
    .text(subtitulo, PAGE_MARGIN, tituloY + 27, {
      width: largura,
      align: "center",
      lineBreak: false
    });

  doc.fillColor("#111827").font("Helvetica");
}

function _desenharRodape(doc, numeroPagina) {
  const w = doc.page.width;
  const h = doc.page.height;
  doc.fillColor("#4b5563")
    .font("Helvetica-Bold")
    .fontSize(9)
    .text(`Página ${numeroPagina}`, w / 2 - 35, h - FOOTER_HEIGHT + 18, {
      width: 70,
      align: "center",
      lineBreak: false
    });
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

function gerarPdfMetricas(data, destino) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    autoFirstPage: false,
    bufferPages: true
  });
  doc.pipe(destino);

  let pagina = 0;
  const larguraUtil = () => doc.page.width - PAGE_MARGIN * 2;
  const areaFimY = () => doc.page.height - FOOTER_HEIGHT - 14;
  const ehHistorico = !!data.mesRef;
  const agora = new Date();
  const dataFmt = agora.toLocaleDateString("pt-BR") + " " + agora.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit"
  });
  const subtitulo = ehHistorico
    ? `Métricas de ${_nomeMes(data.mesRef)}  •  gerado em ${dataFmt}`
    : `Gerado em ${dataFmt}`;
  const rotuloJanela = ehHistorico ? "no mês" : "últimos 30 dias";

  function novaPagina() {
    doc.addPage();
    pagina += 1;
    _desenharFundo(doc);
    _desenharCabecalho(doc, subtitulo);
    _desenharRodape(doc, pagina);
    doc.y = HEADER_HEIGHT + 53;
  }

  function garantirEspaco(alturaNecessaria) {
    if (doc.y + alturaNecessaria > areaFimY()) novaPagina();
  }

  function tituloSecao(texto) {
    garantirEspaco(36);
    doc.moveDown(0.45);
    const y = doc.y;

    doc.roundedRect(PAGE_MARGIN, y, larguraUtil(), 22, 3)
      .fillColor(AZUL_CLARO)
      .fill();

    doc.fillColor(AZUL)
      .font("Helvetica-Bold")
      .fontSize(11.5)
      .text(texto, PAGE_MARGIN + 9, y + 5, {
        width: larguraUtil() - 18,
        lineBreak: false
      });

    doc.y = y + 30;
    doc.fillColor("#111827").font("Helvetica");
  }

  function linhaKpi(rotulo, valor, corValor = "#111827") {
    garantirEspaco(20);
    const y = doc.y;
    const w = larguraUtil();
    const xValor = PAGE_MARGIN + w * 0.62;

    doc.fillColor(CINZA_TEXTO)
      .font("Helvetica")
      .fontSize(10)
      .text(rotulo, PAGE_MARGIN, y, {
        width: w * 0.60,
        lineBreak: false
      });

    doc.fillColor(corValor)
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(String(valor), xValor, y, {
        width: w * 0.38,
        align: "right",
        lineBreak: false
      });

    doc.moveTo(PAGE_MARGIN, y + 15)
      .lineTo(PAGE_MARGIN + w, y + 15)
      .lineWidth(0.35)
      .strokeColor(CINZA_LINHA)
      .stroke();

    doc.y = y + 18;
  }

  function ajustarLargura(texto, largura) {
    texto = String(texto ?? "—");
    if (doc.widthOfString(texto) <= largura) return texto;

    let lo = 0;
    let hi = texto.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidato = texto.slice(0, mid) + "…";
      if (doc.widthOfString(candidato) <= largura) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? texto.slice(0, lo) + "…" : "…";
  }

  function tabela(colunas, larguras, linhas) {
    const alturaEstimada = 25 + Math.min(linhas.length, 28) * 16;
    garantirEspaco(alturaEstimada);

    const w = larguraUtil();
    const xs = [];
    let acc = PAGE_MARGIN;
    for (const frac of larguras) {
      xs.push(acc);
      acc += w * frac;
    }

    const yHead = doc.y;
    doc.roundedRect(PAGE_MARGIN, yHead, w, 19, 2)
      .fillColor(CINZA_CABECALHO)
      .fill();

    doc.fillColor(CINZA_TEXTO)
      .font("Helvetica-Bold")
      .fontSize(8.5);

    colunas.forEach((col, i) => {
      const largura = w * larguras[i] - 8;
      doc.text(ajustarLargura(col, largura), xs[i] + 4, yHead + 5, {
        width: largura,
        lineBreak: false
      });
    });

    doc.y = yHead + 19;
    doc.font("Helvetica").fontSize(9).fillColor("#111827");

    for (const linha of linhas) {
      garantirEspaco(16);
      const y = doc.y;

      linha.forEach((valor, i) => {
        const largura = w * larguras[i] - 8;
        doc.text(ajustarLargura(valor, largura), xs[i] + 4, y + 3, {
          width: largura,
          lineBreak: false
        });
      });

      doc.moveTo(PAGE_MARGIN, y + 15)
        .lineTo(PAGE_MARGIN + w, y + 15)
        .lineWidth(0.35)
        .strokeColor(CINZA_LINHA)
        .stroke();
      doc.y = y + 16;
    }

    if (!linhas.length) {
      doc.fillColor("#9ca3af")
        .font("Helvetica-Oblique")
        .fontSize(9)
        .text("Sem dados ainda.", PAGE_MARGIN, doc.y + 4, { width: w });
      doc.y += 17;
      doc.font("Helvetica").fillColor("#111827");
    }
  }

  novaPagina();

  // Resumo do mês
  tituloSecao("Resumo do mês");
  linhaKpi("Total de atendimentos (mês)", data.mensal + _setaVariacao(data.tendencia?.totalVariacaoPct));
  linhaKpi("Em andamento agora", data.andamento);
  linhaKpi("Resolvidos", data.resolvidos, VERDE);
  linhaKpi("Cancelados", data.cancelados, VERMELHO);
  linhaKpi("Pendentes", data.pendentes);
  if (!ehHistorico) linhaKpi("Tickets hoje", data.hoje);
  linhaKpi("Taxa de resolução", `${data.taxaResolucao}%`);
  linhaKpi(`Horário de pico (${rotuloJanela})`, data.horarioPico ? `${String(data.horarioPico.hora).padStart(2, "0")}h (${data.horarioPico.total} atendimentos)` : "sem dados");
  linhaKpi("Tempo médio de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin) + _setaVariacao(data.tendencia?.tempoResolucaoVariacaoPct));
  linhaKpi("Tempo médio até 1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin) + _setaVariacao(data.tendencia?.tempoRespostaVariacaoPct));
  linhaKpi("Satisfação média", data.satisfacaoMedia != null ? `${data.satisfacaoMedia.toFixed(1)} / 5 (${data.satisfacaoTotalRespostas} avaliações)` : "sem avaliações ainda");

  // Comparação
  tituloSecao("Comparação com o mês anterior");
  tabela(
    ["Métrica", "Mês atual", "Mês anterior", "Variação"],
    [0.40, 0.20, 0.20, 0.20],
    [
      ["Total de atendimentos", data.mensal, data.tendencia?.totalMesAnterior ?? 0, data.tendencia?.totalVariacaoPct != null ? `${data.tendencia.totalVariacaoPct > 0 ? "+" : ""}${data.tendencia.totalVariacaoPct}%` : "—"],
      ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`, `${data.tendencia?.taxaResolucaoMesAnterior ?? 0}%`, data.tendencia?.taxaResolucaoVariacaoPontos != null ? `${data.tendencia.taxaResolucaoVariacaoPontos > 0 ? "+" : ""}${data.tendencia.taxaResolucaoVariacaoPontos}pp` : "—"],
      ["Tempo médio de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), _formatarMin(data.tendencia?.tempoResolucaoAnteriorMin), data.tendencia?.tempoResolucaoVariacaoPct != null ? `${data.tendencia.tempoResolucaoVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoResolucaoVariacaoPct}%` : "—"],
      ["Tempo médio até 1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin), _formatarMin(data.tendencia?.tempoRespostaAnteriorMin), data.tendencia?.tempoRespostaVariacaoPct != null ? `${data.tendencia.tempoRespostaVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoRespostaVariacaoPct}%` : "—"]
    ]
  );

  // Distribuição de notas
  tituloSecao("Distribuição de notas de satisfação");
  const notas = data.distribuicaoNotas || {};
  tabela(
    ["Nota", "Quantidade de avaliações"],
    [0.5, 0.5],
    [5, 4, 3, 2, 1].map(n => [`Nota ${n}`, notas[n] ?? 0])
  );

  // Setores
  tituloSecao(`Atendimentos por setor (${rotuloJanela})`);
  const setores = Object.entries(data.porSetor || {}).sort((a, b) => b[1] - a[1]);
  tabela(["Setor", "Atendimentos"], [0.70, 0.30], setores.map(([setor, total]) => [setor, total]));

  // Atendentes
  tituloSecao("Atendentes");
  if (ehHistorico) {
    tabela(
      ["Atendente", "Mês", "Total histórico", "Em atendimento"],
      [0.38, 0.18, 0.24, 0.20],
      (data.atendentes || []).map(a => [a.nome, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0])
    );
  } else {
    tabela(
      ["Atendente", "Hoje", "7 dias", "Mês", "Total histórico", "Em atendimento"],
      [0.30, 0.12, 0.12, 0.12, 0.19, 0.15],
      (data.atendentes || []).map(a => [a.nome, a.atendidosHoje, a.atendidosSemana, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0])
    );
  }

  // Satisfação por atendente
  tituloSecao("Satisfação por atendente");
  const satisfacaoAtendentes = Object.entries(data.satisfacaoPorAtendente || {}).sort((a, b) => b[1].media - a[1].media);
  tabela(
    ["Atendente", "Média", "Avaliações"],
    [0.50, 0.25, 0.25],
    satisfacaoAtendentes.map(([nome, v]) => [nome, `${v.media.toFixed(1)} / 5`, v.total])
  );

  // Feedbacks negativos
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
