/**
 * Exporta o relatório de métricas em PDF.
 * Layout A4 organizado em blocos, com resumo visual, tabelas compactas
 * e uma segunda página dedicada aos dados de satisfação.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const FUNDO_IMG = fs.readFileSync(path.join(__dirname, "../assets/metricas-papel-timbrado.png"));

const MARGIN = 36;
const HEADER_Y = 92;
const FOOTER_Y = 805;
const AZUL = "#006097";
const AZUL_CLARO = "#eef5f9";
const AZUL_BORDA = "#d8e8f1";
const TEXTO = "#263238";
const TEXTO_SEC = "#5b6570";
const LINHA = "#e5e7eb";
const FUNDO_CARD = "#ffffff";
const CINZA_CARD = "#f6f8fa";
const VERDE = "#16803c";
const VERMELHO = "#c62828";

const MESES_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

function _nomeMes(mesRef) {
  const [ano, mes] = mesRef.split("-").map(Number);
  return `${MESES_PT[mes - 1]}/${ano}`;
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

function _desenharFundo(doc) {
  doc.image(FUNDO_IMG, 0, 0, {
    width: doc.page.width,
    height: doc.page.height
  });
}

function _desenharCabecalho(doc, subtitulo) {
  const largura = doc.page.width - MARGIN * 2;
  doc.fillColor("#111111")
    .font("Helvetica-Bold")
    .fontSize(19)
    .text("RELATÓRIO DE MÉTRICAS", MARGIN, 48, {
      width: largura,
      align: "center",
      lineBreak: false
    });

  doc.fillColor(TEXTO_SEC)
    .font("Helvetica")
    .fontSize(9.5)
    .text(subtitulo, MARGIN, 75, {
      width: largura,
      align: "center",
      lineBreak: false
    });
}

function _desenharRodape(doc, pagina) {
  doc.fillColor("#7a838b")
    .font("Helvetica")
    .fontSize(8)
    .text(`Página ${pagina}`, MARGIN, FOOTER_Y, {
      width: doc.page.width - MARGIN * 2,
      align: "center",
      lineBreak: false
    });
}

function gerarPdfMetricas(data, destino) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    autoFirstPage: false,
    bufferPages: true
  });
  doc.pipe(destino);

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

  function novaPagina(pagina) {
    doc.addPage();
    _desenharFundo(doc);
    _desenharCabecalho(doc, subtitulo);
    _desenharRodape(doc, pagina);
  }

  function secao(titulo, x, y, largura) {
    doc.roundedRect(x, y, largura, 23, 4)
      .fillColor(AZUL_CLARO)
      .fill();
    doc.fillColor(AZUL)
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .text(titulo, x + 9, y + 6, {
        width: largura - 18,
        lineBreak: false
      });
  }

  function card(x, y, largura, altura, rotulo, valor, cor = TEXTO) {
    doc.roundedRect(x, y, largura, altura, 5)
      .fillColor(FUNDO_CARD)
      .fill()
      .lineWidth(0.6)
      .strokeColor(AZUL_BORDA)
      .stroke();

    doc.fillColor(TEXTO_SEC)
      .font("Helvetica")
      .fontSize(8)
      .text(rotulo, x + 9, y + 9, {
        width: largura - 18,
        lineBreak: false
      });

    doc.fillColor(cor)
      .font("Helvetica-Bold")
      .fontSize(13)
      .text(String(valor), x + 9, y + 24, {
        width: largura - 18,
        lineBreak: false
      });
  }

  function truncar(texto, largura, fonte = "Helvetica", tamanho = 8.5) {
    const original = String(texto ?? "—");
    doc.font(fonte).fontSize(tamanho);
    if (doc.widthOfString(original) <= largura) return original;

    let textoAtual = original;
    while (textoAtual.length > 1 && doc.widthOfString(`${textoAtual}…`) > largura) {
      textoAtual = textoAtual.slice(0, -1);
    }
    return `${textoAtual}…`;
  }

  function tabela(x, y, largura, colunas, larguras, linhas, opcoes = {}) {
    const fonte = opcoes.fonte || 8.5;
    const alturaCab = opcoes.alturaCab || 20;
    const alturaLinha = opcoes.alturaLinha || 18;
    const alinhamentos = opcoes.alinhamentos || [];

    doc.roundedRect(x, y, largura, alturaCab, 3)
      .fillColor(CINZA_CARD)
      .fill();

    let atualX = x;
    doc.font("Helvetica-Bold").fontSize(fonte).fillColor(TEXTO);
    colunas.forEach((col, i) => {
      const w = largura * larguras[i];
      doc.text(truncar(col, w - 10, "Helvetica-Bold", fonte), atualX + 5, y + 6, {
        width: w - 10,
        align: alinhamentos[i] || "left",
        lineBreak: false
      });
      atualX += w;
    });

    let atualY = y + alturaCab;
    doc.font("Helvetica").fontSize(fonte).fillColor(TEXTO);

    if (!linhas.length) {
      doc.fillColor("#8a939b")
        .font("Helvetica-Oblique")
        .fontSize(fonte)
        .text("Sem dados ainda.", x + 5, atualY + 5, { width: largura });
      return atualY + 18;
    }

    linhas.forEach((linha, indice) => {
      if (indice % 2 === 1) {
        doc.rect(x, atualY, largura, alturaLinha).fillColor("#fbfcfd").fill();
      }

      atualX = x;
      linha.forEach((valor, i) => {
        const w = largura * larguras[i];
        doc.fillColor(TEXTO)
          .font("Helvetica")
          .fontSize(fonte)
          .text(truncar(valor, w - 10, "Helvetica", fonte), atualX + 5, atualY + 5, {
            width: w - 10,
            align: alinhamentos[i] || "left",
            lineBreak: false
          });
        atualX += w;
      });

      doc.moveTo(x, atualY + alturaLinha)
        .lineTo(x + largura, atualY + alturaLinha)
        .lineWidth(0.35)
        .strokeColor(LINHA)
        .stroke();
      atualY += alturaLinha;
    });

    return atualY;
  }

  // =========================
  // PÁGINA 1 — VISÃO GERAL
  // =========================
  novaPagina(1);

  secao("Resumo do mês", MARGIN, HEADER_Y, doc.page.width - MARGIN * 2);

  const gap = 8;
  const cardsY = HEADER_Y + 31;
  const cardW = (doc.page.width - MARGIN * 2 - gap * 3) / 4;
  const cardH = 49;
  const valores = [
    ["Atendimentos", `${data.mensal}${_setaVariacao(data.tendencia?.totalVariacaoPct)}`],
    ["Em andamento", data.andamento],
    ["Resolvidos", data.resolvidos, VERDE],
    ["Cancelados", data.cancelados, VERMELHO],
    ["Pendentes", data.pendentes],
    ["Taxa de resolução", `${data.taxaResolucao}%`],
    ["Horário de pico", data.horarioPico ? `${String(data.horarioPico.hora).padStart(2, "0")}h (${data.horarioPico.total})` : "sem dados"],
    ["Satisfação média", data.satisfacaoMedia != null ? `${data.satisfacaoMedia.toFixed(1)} / 5` : "sem dados"],
    ["Tempo de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin) + _setaVariacao(data.tendencia?.tempoResolucaoVariacaoPct)],
    ["1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin) + _setaVariacao(data.tendencia?.tempoRespostaVariacaoPct)],
    ["Avaliações", data.satisfacaoTotalRespostas ?? 0],
    ["Janela", rotuloJanela]
  ];

  valores.forEach((item, i) => {
    const linha = Math.floor(i / 4);
    const coluna = i % 4;
    card(MARGIN + coluna * (cardW + gap), cardsY + linha * (cardH + gap), cardW, cardH, item[0], item[1], item[2] || TEXTO);
  });

  const blocoY = cardsY + 3 * (cardH + gap) + 10;
  const metade = (doc.page.width - MARGIN * 2 - gap) / 2;

  // Comparação com mês anterior
  secao("Comparação com o mês anterior", MARGIN, blocoY, metade);
  const comparacaoFim = tabela(
    MARGIN,
    blocoY + 29,
    metade,
    ["Métrica", "Atual", "Anterior", "Var."],
    [0.46, 0.18, 0.20, 0.16],
    [
      ["Atendimentos", data.mensal, data.tendencia?.totalMesAnterior ?? 0, data.tendencia?.totalVariacaoPct != null ? `${data.tendencia.totalVariacaoPct > 0 ? "+" : ""}${data.tendencia.totalVariacaoPct}%` : "—"],
      ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`, `${data.tendencia?.taxaResolucaoMesAnterior ?? 0}%`, data.tendencia?.taxaResolucaoVariacaoPontos != null ? `${data.tendencia.taxaResolucaoVariacaoPontos > 0 ? "+" : ""}${data.tendencia.taxaResolucaoVariacaoPontos}pp` : "—"],
      ["Tempo de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), _formatarMin(data.tendencia?.tempoResolucaoAnteriorMin), data.tendencia?.tempoResolucaoVariacaoPct != null ? `${data.tendencia.tempoResolucaoVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoResolucaoVariacaoPct}%` : "—"],
      ["1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin), _formatarMin(data.tendencia?.tempoRespostaAnteriorMin), data.tendencia?.tempoRespostaVariacaoPct != null ? `${data.tendencia.tempoRespostaVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoRespostaVariacaoPct}%` : "—"]
    ],
    { alinhamentos: ["left", "right", "right", "right"] }
  );

  // Satisfação / notas
  const direitaX = MARGIN + metade + gap;
  secao("Distribuição de notas de satisfação", direitaX, blocoY, metade);
  const notas = data.distribuicaoNotas || {};
  tabela(
    direitaX,
    blocoY + 29,
    metade,
    ["Nota", "Avaliações"],
    [0.55, 0.45],
    [5, 4, 3, 2, 1].map(n => [`Nota ${n}`, notas[n] ?? 0]),
    { alinhamentos: ["left", "right"] }
  );

  const baixoY = Math.max(comparacaoFim, blocoY + 29 + 20 + 5 * 18) + 14;
  const setoresLargura = metade;
  secao(`Atendimentos por setor (${rotuloJanela})`, MARGIN, baixoY, setoresLargura);
  const setores = Object.entries(data.porSetor || {}).sort((a, b) => b[1] - a[1]);
  tabela(
    MARGIN,
    baixoY + 29,
    setoresLargura,
    ["Setor", "Atendimentos"],
    [0.68, 0.32],
    setores.map(([setor, total]) => [setor, total]),
    { alinhamentos: ["left", "right"] }
  );

  secao("Atendentes", direitaX, baixoY, metade);
  if (ehHistorico) {
    tabela(
      direitaX,
      baixoY + 29,
      metade,
      ["Atendente", "Mês", "Histórico", "Em atendimento"],
      [0.37, 0.16, 0.21, 0.26],
      (data.atendentes || []).map(a => [a.nome, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]),
      { alinhamentos: ["left", "right", "right", "right"], fonte: 7.8 }
    );
  } else {
    tabela(
      direitaX,
      baixoY + 29,
      metade,
      ["Atendente", "Hoje", "7d", "Mês", "Hist.", "Agora"],
      [0.28, 0.13, 0.11, 0.13, 0.18, 0.17],
      (data.atendentes || []).map(a => [a.nome, a.atendidosHoje, a.atendidosSemana, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]),
      { alinhamentos: ["left", "right", "right", "right", "right", "right"], fonte: 7.2 }
    );
  }

  // =========================
  // PÁGINA 2 — SATISFAÇÃO
  // =========================
  novaPagina(2);
  secao("Satisfação por atendente", MARGIN, HEADER_Y, doc.page.width - MARGIN * 2);
  const satisfacaoAtendentes = Object.entries(data.satisfacaoPorAtendente || {}).sort((a, b) => b[1].media - a[1].media);
  const satisfacaoFim = tabela(
    MARGIN,
    HEADER_Y + 29,
    doc.page.width - MARGIN * 2,
    ["Atendente", "Média", "Avaliações"],
    [0.58, 0.21, 0.21],
    satisfacaoAtendentes.map(([nome, v]) => [nome, `${Number(v.media || 0).toFixed(1)} / 5`, v.total]),
    { alinhamentos: ["left", "right", "right"] }
  );

  const feedbackY = satisfacaoFim + 18;
  secao("O que os clientes disseram (notas 1-2, mais recentes)", MARGIN, feedbackY, doc.page.width - MARGIN * 2);

  const feedbacks = (data.feedbacksNegativos || []).slice(0, 15);
  const tabelaX = MARGIN;
  const tabelaY = feedbackY + 29;
  const tabelaW = doc.page.width - MARGIN * 2;
  const colW = [0.17, 0.21, 0.10, 0.52];
  const cabH = 20;

  doc.roundedRect(tabelaX, tabelaY, tabelaW, cabH, 3)
    .fillColor(CINZA_CARD)
    .fill();
  doc.font("Helvetica-Bold").fontSize(8).fillColor(TEXTO);
  let cx = tabelaX;
  ["Protocolo", "Cliente", "Nota", "Comentário"].forEach((col, i) => {
    const w = tabelaW * colW[i];
    doc.text(col, cx + 5, tabelaY + 6, { width: w - 10, lineBreak: false });
    cx += w;
  });

  let fy = tabelaY + cabH;
  if (!feedbacks.length) {
    doc.fillColor("#8a939b").font("Helvetica-Oblique").fontSize(9)
      .text("Sem dados ainda.", tabelaX + 5, fy + 5, { width: tabelaW });
  } else {
    feedbacks.forEach((f, indice) => {
      const protocolo = `#${f.protocolo}`;
      const cliente = f.customerName || "Não informado";
      const nota = `${f.rating}/5`;
      const comentario = f.feedback || "Sem comentário";
      const comentarioW = tabelaW * colW[3] - 10;
      doc.font("Helvetica").fontSize(8.2);
      const alturaTexto = Math.max(18, doc.heightOfString(comentario, { width: comentarioW, lineGap: 1 }));
      const altura = Math.min(Math.max(alturaTexto + 7, 18), 42);

      if (indice % 2 === 1) {
        doc.rect(tabelaX, fy, tabelaW, altura).fillColor("#fbfcfd").fill();
      }

      cx = tabelaX;
      [protocolo, cliente, nota].forEach((valor, i) => {
        const w = tabelaW * colW[i];
        doc.fillColor(TEXTO).font("Helvetica").fontSize(8.2)
          .text(truncar(valor, w - 10, "Helvetica", 8.2), cx + 5, fy + 5, { width: w - 10, lineBreak: false });
        cx += w;
      });

      doc.fillColor(TEXTO).font("Helvetica").fontSize(8.2)
        .text(comentario, cx + 5, fy + 5, {
          width: comentarioW,
          height: altura - 6,
          lineGap: 1,
          ellipsis: true
        });

      doc.moveTo(tabelaX, fy + altura)
        .lineTo(tabelaX + tabelaW, fy + altura)
        .lineWidth(0.35)
        .strokeColor(LINHA)
        .stroke();
      fy += altura;
    });
  }

  doc.end();
}

module.exports = { gerarPdfMetricas };
