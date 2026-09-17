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
// 2026-09-16 (pedido do usuário, 2ª rodada: "desça bem mais por favor") —
// primeiro ajuste (112/136/168) só tirou da faixa azul; usuário pediu mais
// espaço ainda. Valores bem mais baixos, com folga de sobra até o rodapé
// (conteúdo da página 1 termina bem antes dos ~794pt úteis do A4).
const TITULO_Y = 170;
const SUBTITULO_Y = 196;
const TOP = 230;
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

// Pedido do usuário (2026-09-16): "aos que tem referencia do mês anterior
// [...] coloque uma cor verde ou vermelho caso inferior" — antes a variação
// (ex: "+870%") ia colada no mesmo texto/cor do valor principal do card,
// sem destaque. Retorna { texto, bom } pra cartao() desenhar a variação
// separada, menor e colorida. `invertido=true` é pra métricas onde SUBIR é
// RUIM (tempo de resolução/resposta — demorar mais não é bom), mesmo
// critério já usado no painel ao vivo (metricTrendHtml em 05-metrics.js).
//
// Pedido do usuário (2026-09-17, print real com "+178% vs mês ant." no card
// de Tempo de resolução): "seria mais rapido ou mais lento que o mes
// anterior?" — pra métricas de tempo, "+178%" sozinho exige o leitor saber
// de cabeça que invertido=true significa "subir é ruim", o que não é óbvio
// batendo o olho no card. `rotulos = [textoBom, textoRuim]` troca o "vs mês
// ant." genérico por uma palavra que já responde a pergunta direto (ex:
// "178% mais lento").
function _tendenciaInfo(pct, invertido = false, rotulos = null) {
  if (pct == null) return null;
  if (pct === 0) return { texto: "= vs mês ant.", bom: null };
  const subiu = pct > 0;
  const bom = invertido ? !subiu : subiu;
  if (rotulos) {
    return { texto: `${Math.abs(pct)}% ${bom ? rotulos[0] : rotulos[1]}`, bom };
  }
  return { texto: `${subiu ? "+" : ""}${pct}% vs mês ant.`, bom };
}

// Mesmo critério de _tendenciaInfo, só que devolvendo direto a cor — usado
// pra colorir a coluna "Variação" da tabela "Comparação com o mês anterior"
// (pedido do usuário: "deixe comparações com mes anterior de uma forma que
// seja mais entendivel" — cor verde/vermelho deixa claro de cara se aquele
// número foi bom ou ruim, sem precisar interpretar o sinal do %/pp).
function _corTendencia(valor, invertido = false) {
  if (valor == null || valor === 0) return SEC;
  const subiu = valor > 0;
  const bom = invertido ? !subiu : subiu;
  return bom ? VERDE : VERMELHO;
}

// Pedido do usuário (2026-09-16): "horario de pico deixe no formato de hora
// mesmo, por exemplo 10:30am" — porHora só tem granularidade de HORA (sem
// minuto, ver EXTRACT(HOUR ...) em metrics.service.js), então os minutos
// exibidos são sempre ":00"; o pedido em si é sobre usar hora cheia em
// formato 12h com am/pm em vez de "10h".
function _formatarHora12(hora) {
  const h = Number(hora);
  const periodo = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00${periodo}`;
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
  // Pedido do usuário (2026-09-16): "resumo do mês deveria mostrar qual mês
  // especificamente" — nomeMesExibido cobre os dois casos: com mesRef (PDF
  // histórico) usa o mês escolhido; sem mesRef (mês corrente, comportamento
  // de sempre) usa o mês/ano de "agora", já que é esse o mês que
  // metrics.service.js usou pra calcular tudo quando nenhum mês é passado.
  const nomeMesExibido = historico ? _nomeMes(data.mesRef) : `${MESES_PT[agora.getMonth()]}/${agora.getFullYear()}`;
  const subtitulo = historico ? `Métricas de ${nomeMesExibido}  •  gerado em ${geradoEm}` : `Gerado em ${geradoEm}`;
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

  function cartao(x, y, w, h, titulo, valor, cor = TEXTO, trend = null) {
    doc.roundedRect(x, y, w, h, 5).fillColor(CARD).fill().lineWidth(0.7).strokeColor(AZUL_BORDA).stroke();
    doc.fillColor(SEC).font("Helvetica").fontSize(7.8)
      .text(titulo, x + 9, y + 8, { width: w - 18, lineBreak: false });
    doc.fillColor(cor).font("Helvetica-Bold").fontSize(13)
      .text(String(valor), x + 9, y + 23, { width: w - 18, lineBreak: false });
    // Pedido do usuário (2026-09-16): variação vs mês anterior destacada —
    // linha própria, menor, verde quando é uma variação boa e vermelha
    // quando é ruim (ver _tendenciaInfo — critério "bom" já leva em conta
    // métricas invertidas, tipo tempo de resolução).
    if (trend) {
      const corTrend = trend.bom === true ? VERDE : trend.bom === false ? VERMELHO : SEC;
      doc.fillColor(corTrend).font("Helvetica-Bold").fontSize(8)
        .text(trend.texto, x + 9, y + 39, { width: w - 18, lineBreak: false });
    }
  }

  function textoCab(x, y, w, texto, align = "left", size = 8) {
    doc.fillColor(SEC).font("Helvetica-Bold").fontSize(size)
      .text(String(texto), x, y, { width: w, align, lineBreak: false });
  }

  function textoCel(x, y, w, texto, align = "left", size = 8.2, bold = false, cor = TEXTO) {
    doc.fillColor(cor).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
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
        // Pedido do usuário (2026-09-16): "deixe comparações com mes
        // anterior de uma forma que seja mais entendivel" — coluna final
        // (Variação) pode vir colorida verde/vermelho por linha via
        // opts.coresUltimaCol (ver _corTendencia), em negrito pra destacar.
        const ultimaCol = i === colunas.length - 1;
        const corCel = ultimaCol && opts.coresUltimaCol?.[idx] ? opts.coresUltimaCol[idx] : TEXTO;
        textoCel(cx + 5, cy + 5, cw - 10, valor, opts.align?.[i] || "left", fs, ultimaCol && !!opts.coresUltimaCol?.[idx], corCel);
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
  faixa(`Resumo de ${nomeMesExibido}`, MARGIN, TOP, W);

  const cardW = (W - gap * 3) / 4;
  // Pedido do usuário (2026-09-16): variação vs mês anterior ganhou linha
  // própria colorida dentro do card (ver cartao()) — cardH subiu de 48 pra
  // 58 pra abrir espaço pra essa linha extra sem espremer o valor principal.
  const cardH = 58;
  const cardsY = TOP + 30;
  // BUG CORRIGIDO (2026-09-16, relatado pelo usuário com print real: "como é
  // possivel 688 resolvidos se teve 84 atendimentos"): "Resolvidos" usava
  // data.resolvidos — contagem DESDE SEMPRE (status atual de todos os
  // tickets, sem filtro de data nenhum, ver summaryRes em metrics.service.js)
  // — enquanto "Atendimentos" ao lado já usava data.mensal (só o mês). Isso
  // criava números que pareciam quebrados (688 resolvidos num mês com só 84
  // atendimentos). O mesmo cálculo já existia certo em outro lugar deste
  // arquivo (tabela "Comparação com o mês anterior" usa
  // tendencia.mesAtualResolvidos/taxaResolucaoAtual) — só não estava sendo
  // usado aqui nos cards.
  //
  // Pedido do usuário (2026-09-16): "retire andamentos e cancelados" — os
  // dois saíram da grade (eram a foto de AGORA, sem filtro de mês nenhum,
  // igual "Pendentes" que continua — não tinham "versão do mês" que fizesse
  // sentido, o que também ajudava a confundir com o resto dos cards).
  //
  // Pedido do usuário (2026-09-17): "remova janela e pendentes" — "Janela"
  // (rótulo "no mês"/"últimos 30 dias") e "Pendentes" saíram da grade, que
  // agora fecha certinho em 2 linhas de 4 cards (8 no total) sem sobrar
  // espaço vazio. "Pendentes" nunca teve versão do mês (é a foto de AGORA,
  // igual Em andamento/Cancelados que já tinham saído por esse motivo);
  // "Janela" só explicava o período do PDF, informação que já está no
  // subtítulo do cabeçalho.
  //
  // Pedido do usuário (2026-09-17, print real com "+178% vs mês ant." no
  // card de Tempo de resolução): "seria mais rapido ou mais lento que o mes
  // anterior?" — as duas métricas de tempo (Tempo de resolução e 1ª
  // resposta) agora usam _tendenciaInfo(..., rotulos) pra trocar o "%"
  // genérico por "mais rápido"/"mais lento" já dito por extenso. "1ª
  // resposta" também virou "Tempo de 1ª resposta" (pergunta do usuário: "o
  // que seria" — é o tempo médio até o atendente assumir/responder o
  // ticket, então o título deixa isso explícito, igual "Tempo de
  // resolução" ao lado).
  const ROTULOS_TEMPO = ["mais rápido", "mais lento"];
  const valores = [
    ["Atendimentos", data.mensal ?? 0, TEXTO, _tendenciaInfo(data.tendencia?.totalVariacaoPct)],
    ["Resolvidos", data.tendencia?.mesAtualResolvidos ?? 0, VERDE],
    ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`],
    // Pedido do usuário (2026-09-16): "horario de pico deixe no formato de
    // hora mesmo, por exemplo 10:30am" — só tem granularidade de hora (sem
    // minuto, ver _formatarHora12), então os minutos exibidos são sempre
    // ":00", mas o formato agora é relógio 12h com am/pm em vez de "10h".
    // Pedido do usuário (2026-09-17): total de atendimentos naquele horário
    // no mês saiu do "(39)" colado no valor principal e virou uma linha
    // própria embaixo, em verde — reaproveitando o mesmo slot de "trend" do
    // card (ver cartao()), só que fixo em verde (bom: true) por não ser uma
    // comparação com mês anterior, e sim um destaque informativo.
    ["Horário de pico", data.horarioPico ? _formatarHora12(data.horarioPico.hora) : "sem dados", TEXTO,
      data.horarioPico ? { texto: `${data.horarioPico.total} atendimentos no mês`, bom: true } : null],
    ["Satisfação média", data.satisfacaoMedia != null ? `${Number(data.satisfacaoMedia).toFixed(1)} / 5` : "sem dados"],
    ["Tempo de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), TEXTO, _tendenciaInfo(data.tendencia?.tempoResolucaoVariacaoPct, true, ROTULOS_TEMPO)],
    ["Tempo de 1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin), TEXTO, _tendenciaInfo(data.tendencia?.tempoRespostaVariacaoPct, true, ROTULOS_TEMPO)],
    ["Avaliações", data.satisfacaoTotalRespostas ?? 0]
  ];
  valores.forEach((v, i) => cartao(MARGIN + (i % 4) * (cardW + gap), cardsY + Math.floor(i / 4) * (cardH + gap), cardW, cardH, v[0], v[1], v[2] || TEXTO, v[3] || null));

  // linhasCards calculado a partir de valores.length (e não mais fixo em 3)
  // pra não sobrar espaço vazio depois que "Pendentes"/"Janela" saíram e a
  // grade encolheu de 10 pra 8 cards (2 linhas de 4 em vez de 3).
  const linhasCards = Math.ceil(valores.length / 4);
  const blocoY = cardsY + linhasCards * (cardH + gap) + 12;
  const colW = (W - gap) / 2;

  // Pedido do usuário (2026-09-16): "deixe comparações com mes anterior de
  // uma forma que seja mais entendivel" — cabeçalhos mais explícitos
  // ("Este mês"/"Mês anterior" em vez de "Atual"/"Anterior") e a coluna
  // "Variação" agora vem colorida (verde=bom, vermelho=ruim) e em negrito,
  // igual ao destaque que os cards de cima já ganharam — mesmo critério
  // "invertido" (tempo subir é ruim) de _corTendencia/_tendenciaInfo.
  faixa("Comparação com o mês anterior", MARGIN, blocoY, colW);
  const compFim = tabela(MARGIN, blocoY + 27, colW, ["Métrica", "Este mês", "Mês anterior", "Variação"], [0.36, 0.20, 0.24, 0.20], [
    ["Atendimentos", data.mensal ?? 0, data.tendencia?.totalMesAnterior ?? 0, data.tendencia?.totalVariacaoPct != null ? `${data.tendencia.totalVariacaoPct > 0 ? "+" : ""}${data.tendencia.totalVariacaoPct}%` : "—"],
    ["Taxa de resolução", `${data.tendencia?.taxaResolucaoAtual ?? 0}%`, `${data.tendencia?.taxaResolucaoMesAnterior ?? 0}%`, data.tendencia?.taxaResolucaoVariacaoPontos != null ? `${data.tendencia.taxaResolucaoVariacaoPontos > 0 ? "+" : ""}${data.tendencia.taxaResolucaoVariacaoPontos}pp` : "—"],
    ["Tempo de resolução", _formatarMin(data.tendencia?.tempoResolucaoAtualMin), _formatarMin(data.tendencia?.tempoResolucaoAnteriorMin), data.tendencia?.tempoResolucaoVariacaoPct != null ? `${data.tendencia.tempoResolucaoVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoResolucaoVariacaoPct}%` : "—"],
    ["Tempo de 1ª resposta", _formatarMin(data.tendencia?.tempoRespostaAtualMin), _formatarMin(data.tendencia?.tempoRespostaAnteriorMin), data.tendencia?.tempoRespostaVariacaoPct != null ? `${data.tendencia.tempoRespostaVariacaoPct > 0 ? "+" : ""}${data.tendencia.tempoRespostaVariacaoPct}%` : "—"]
  ], {
    align: ["left", "right", "right", "right"],
    coresUltimaCol: [
      _corTendencia(data.tendencia?.totalVariacaoPct),
      _corTendencia(data.tendencia?.taxaResolucaoVariacaoPontos),
      _corTendencia(data.tendencia?.tempoResolucaoVariacaoPct, true),
      _corTendencia(data.tendencia?.tempoRespostaVariacaoPct, true)
    ]
  });

  const x2 = MARGIN + colW + gap;
  faixa("Distribuição de notas de satisfação", x2, blocoY, colW);
  tabela(x2, blocoY + 27, colW, ["Nota", "Avaliações"], [0.55, 0.45], [5, 4, 3, 2, 1].map(n => [`Nota ${n}`, data.distribuicaoNotas?.[n] ?? 0]), { align: ["left", "right"] });

  // Pedido do usuário (2026-09-16): "remova atendimentos por setor" — saiu
  // do relatório (já tinha saído do painel ao vivo antes, ver histórico).
  // "Atendentes" ocupa a largura toda agora que não divide mais a linha com
  // a tabela de Setor.
  const baixoY = Math.max(compFim, blocoY + 27 + 20 + 5 * 18) + 12;
  faixa("Atendentes", MARGIN, baixoY, W);
  if (historico) {
    tabela(MARGIN, baixoY + 27, W, ["Atendente", "Mês", "Histórico", "Em atendimento agora"], [0.46, 0.18, 0.18, 0.18], (data.atendentes || []).map(a => [a.nome, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]), { align: ["left", "right", "right", "right"], fonte: 8 });
  } else {
    tabela(MARGIN, baixoY + 27, W, ["Atendente", "Hoje", "7 dias", "Mês", "Histórico", "Em atendimento agora"], [0.34, 0.12, 0.12, 0.12, 0.15, 0.15], (data.atendentes || []).map(a => [a.nome, a.atendidosHoje, a.atendidosSemana, a.atendidosMes, a.totalAtendidos, a.emAtendimento ?? 0]), { align: ["left", "right", "right", "right", "right", "right"], fonte: 7.8 });
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
