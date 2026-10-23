/**
 * Catálogo Completo — modelo "Catálogo de Produtos" do Canva, em rolagem contínua.
 *
 * Pedido do usuário (2026-10-20): o Catálogo Completo deixa de ser paginado em A4
 * (impressão só existe no Catálogo Promocional, montado por seleção de itens) e
 * passa a seguir o modelo do Canva — cabeçalho azul com logo e título, "categoria"
 * em azul, cards de 2 por linha (moldura cinza, foto grande, nome em azul, código
 * do fabricante, outros códigos e descrição) — numa página única, comprida.
 *
 * Sem página, não há card vazio de preenchimento, nem vão antes do rodapé, nem
 * grupo cortado no meio. A altura do card varia com o texto (a descrição aparece
 * inteira, dentro de um teto de linhas). O PDF limita a altura de cada página
 * (~14.400 pt no Acrobat), por isso o conteúdo é dividido em "partes" — cada parte
 * é uma página alta; vistas em rolagem contínua, emendam sem costura visível
 * (cabeçalho só na 1ª parte, barra de rodapé só na última).
 *
 * Reaproveita do gerador padrão (catalogo-pdf.service.js → _interno): fotos
 * (_fotosUtilizaveis/_desenharFotoProtegida), código do fabricante, nome, agrupamento
 * por Linha/marca e o selo elétrico (tensão | corrente).
 */
const path = require("path");
const PDFDocument = require("pdfkit");

const ASSETS = path.join(__dirname, "..", "assets");
const IMG_CABECALHO = path.join(ASSETS, "catalogo-completo-v2-cabecalho.png"); // 800×110
const IMG_LOGO = path.join(ASSETS, "catalogo-completo-v2-logo.png"); // 320×305
const IMG_RODAPE = path.join(ASSETS, "catalogo-completo-v2-rodape.png"); // 800×40
const FONTES = path.join(ASSETS, "fonts");

const F = {
  regular: ["MS-Regular", path.join(FONTES, "montserrat-latin-400-normal.woff")],
  italico: ["MS-Italic", path.join(FONTES, "montserrat-latin-400-italic.woff")],
  medio: ["MS-Medium", path.join(FONTES, "montserrat-latin-500-normal.woff")],
  semiItalico: ["MS-SemiBoldItalic", path.join(FONTES, "montserrat-latin-600-italic.woff")],
  negrito: ["MS-Bold", path.join(FONTES, "montserrat-latin-700-normal.woff")],
  negritoItalico: ["MS-BoldItalic", path.join(FONTES, "montserrat-latin-700-italic.woff")],
  extraItalico: ["MS-ExtraBoldItalic", path.join(FONTES, "montserrat-latin-800-italic.woff")],
};

// Medidas tiradas do PDF exportado do modelo (A4: 595,28 × 841,89 pt).
const LARGURA = 595.28;
const MARGEM_X = 37;
const GAP_X = 15;
const CARD_W = (LARGURA - MARGEM_X * 2 - GAP_X) / 2;
const GAP_Y = 16;
const PAD_X = 7.6;
const PAD_TOPO = 11;
const FOTO_H = 150;
const FOTO_MB = 16; // espaço entre a foto e o nome (margin-bottom da foto)
const CODIGO_H = 15; // faixa própria acima da foto para o "Cód." (não encosta na imagem)
const FOTO_W = CARD_W - PAD_X * 2;
const CABECALHO_H = (LARGURA * 110) / 800;
const RODAPE_H = (LARGURA * 40) / 800;
const CATEGORIA_X = 27.75;

const AZUL = "#0081b8";
const AZUL_SELO = "#005aaa";
const FUNDO_SELO = "#e6eef8";
const BORDA_CARD = "#a5a5a5";
const BORDA_FOTO = "#8a8a8a";
const LINHA_CATEGORIA = "#bfc3c8";
const TEXTO = "#111827";
const AZUL_MARINHO = "#0b2a5b"; // nome do produto

const ALTURA_MAX_PARTE = 14000;
const LINHAS_DESCRICAO_MAX = 4; // pedido: aplicação até 4 linhas; se não couber, termina em "..."
const PASSO_DESCRICAO = 11.4;
const FONTE_DESCRICAO = 7.0;

function registrar(doc) {
  Object.values(F).forEach(([nome, arquivo]) => doc.registerFont(nome, arquivo));
}

function montarCard(med, H, produto) {
  const codigoFab = H._rotuloProduto(produto);
  const nome = H._nomeExibicao(produto, true).toUpperCase();
  // Pedido do usuário (2026-10-20): "Cód." passa a ser o código da LOJA; à direita ficam o código do fabricante
  // e os equivalentes, até 5 no total (sem repetir).
  const norm = (t) => String(t).replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  const outros = codigoFab && String(codigoFab).trim() && String(codigoFab) !== String(produto.codigo) ? [String(codigoFab).trim()] : [];
  // Equivalentes: embaixo da descrição; ignora o que já aparece no nome (azul), o código da loja e o do fabricante.
  const vistos = new Set([norm(produto.codigo), norm(codigoFab || "")]);
  const nomeNorm = norm(nome);
  const equivalentes = [];
  (Array.isArray(produto.equivalentes) ? produto.equivalentes : []).forEach((e) => {
    const t = String(H._limparCodigoOemParaExibicao(e) || "").trim();
    const k = norm(t);
    if (!k || vistos.has(k) || nomeNorm.includes(k) || equivalentes.length >= 5) return;
    vistos.add(k); equivalentes.push(t);
  });
  const equivalentesTxt = equivalentes.join(", ");
  const descricaoBruta = String(produto.aplicacaoOrganizada || produto.aplicacao || produto.descricaoComercial || "").trim();

  const larguraTexto = FOTO_W - 4;
  med.font(F.negritoItalico[0]).fontSize(11.5);
  const nomeH = Math.min(med.heightOfString(nome, { width: FOTO_W, align: "center" }), med.currentLineHeight() * 2 + 1);

  let descricao = descricaoBruta;
  let descricaoH = 0;
  if (descricao) {
    med.font(F.medio[0]).fontSize(FONTE_DESCRICAO);
    const opts = { width: larguraTexto, lineGap: 1.6 };
    const teto = LINHAS_DESCRICAO_MAX * med.currentLineHeight() + (LINHAS_DESCRICAO_MAX - 1) * 1.6 + 0.5;
    if (med.heightOfString(descricao, opts) > teto) {
      let lo = 0;
      let hi = descricao.length;
      while (lo < hi) {
        const meio = Math.ceil((lo + hi) / 2);
        if (med.heightOfString(`${descricao.slice(0, meio).trimEnd()}...`, opts) <= teto) lo = meio; else hi = meio - 1;
      }
      descricao = lo > 0 ? `${descricao.slice(0, lo).trimEnd()}...` : "...";
    }
    descricaoH = med.heightOfString(descricao, { width: larguraTexto, lineGap: 1.6, align: "justify" });
  }

  let h = PAD_TOPO + CODIGO_H + FOTO_H + FOTO_MB + nomeH + 9;
  if (descricao) h += 9 + 13 + 6 + descricaoH;
  let equivH = 0;
  if (equivalentesTxt) {
    med.font(F.medio[0]).fontSize(FONTE_DESCRICAO);
    equivH = med.heightOfString(equivalentesTxt, { width: larguraTexto, lineGap: 1.6 });
    h += 9 + 13 + 4 + equivH;
  }
  h += 12;
  return { produto, codigoFab, nome, nomeH, outros, equivalentesTxt, equivH, descricao, descricaoH, h, spec: H._extrairEspecEletrica(produto) };
}

function desenharCard(doc, H, card, x, y, altura) {
  doc.lineWidth(0.8).strokeColor(BORDA_CARD).rect(x, y, CARD_W, altura).stroke();

  const xf = x + PAD_X;
  const yf = y + PAD_TOPO + CODIGO_H;
  // Moldura ao redor da foto removida (pedido do usuário, 2026-10-20) — a foto fica solta, só a borda do card.

  const fotos = H._fotosUtilizaveis(doc, card.produto.codigo);
  const folga = 3;
  let desenhadas = 0;
  if (fotos.length >= 2) {
    const meia = (FOTO_W - folga * 2 - 4) / 2;
    if (H._desenharFotoProtegida(doc, fotos[0], xf + folga, yf + folga, meia, FOTO_H - folga * 2)) desenhadas += 1;
    if (H._desenharFotoProtegida(doc, fotos[1], xf + folga + meia + 4, yf + folga, meia, FOTO_H - folga * 2)) desenhadas += 1;
  } else if (fotos.length === 1) {
    if (H._desenharFotoProtegida(doc, fotos[0], xf + folga, yf + folga, FOTO_W - folga * 2, FOTO_H - folga * 2)) desenhadas += 1;
  }
  if (!desenhadas) {
    doc.font(F.italico[0]).fontSize(8).fillColor("#9ca3af")
      .text("sem foto", xf, yf + FOTO_H / 2 - 5, { width: FOTO_W, align: "center", lineBreak: false });
  }

  // Selo "12V | 90A" no canto superior direito da moldura da foto.
  if (card.spec) {
    const partes = [card.spec.tensao, card.spec.corrente].filter(Boolean).join("  |  ");
    doc.font(F.negrito[0]).fontSize(7);
    const lw = doc.widthOfString(partes) + 10;
    const xs = xf + FOTO_W - lw - 4;
    doc.rect(xs, yf + 4, lw, 12).fillColor(FUNDO_SELO).fill();
    doc.fillColor(AZUL_SELO).text(partes, xs, yf + 6.6, { width: lw, align: "center", lineBreak: false });
  }

  // Código interno no canto superior esquerdo do card, acima da foto.
  doc.fillColor(TEXTO).font(F.negrito[0]).fontSize(9.5)
    .text(`Cód. ${card.produto.codigo}`, xf + 2, y + PAD_TOPO - 3, { width: FOTO_W * 0.5, lineBreak: false, ellipsis: true });

  let cy = yf + FOTO_H + FOTO_MB;
  doc.fillColor(AZUL_MARINHO).font(F.negritoItalico[0]).fontSize(11.5)
    .text(card.nome, xf, cy, { width: FOTO_W, height: card.nomeH + 1, align: "center", ellipsis: true });
  cy += card.nomeH + 9;

  if (card.descricao) {
    doc.fillColor(TEXTO).font(F.semiItalico[0]).fontSize(9.5).text("Descrição", xf + 2, cy, { lineBreak: false });
    cy += 13 + 6;
    doc.fillColor("#000000").font(F.medio[0]).fontSize(FONTE_DESCRICAO)
      .text(card.descricao, xf + 2, cy, { width: FOTO_W - 4, lineGap: 1.6, align: "justify" });
    cy += card.descricaoH;
  }
  if (card.equivalentesTxt) {
    cy += card.descricao ? 9 : 0;
    doc.fillColor(TEXTO).font(F.semiItalico[0]).fontSize(9.5).text("Equivalentes:", xf + 2, cy, { lineBreak: false });
    cy += 13 + 4;
    doc.fillColor("#000000").font(F.medio[0]).fontSize(FONTE_DESCRICAO)
      .text(card.equivalentesTxt, xf + 2, cy, { width: FOTO_W - 4, lineGap: 1.6 });
  }
  doc.fillColor(TEXTO).font("Helvetica");
}

function planejar(med, H, grupos, agruparPorMarca) {
  const blocos = [];
  grupos.forEach(({ linha, itens }) => {
    blocos.push({ tipo: "categoria", texto: String(linha), h: 14 + 12 + 18 + 18 });
    const subgrupos = agruparPorMarca
      ? [{ marca: null, produtos: itens }]
      : H._agruparPorMarca(itens).map((g) => ({ marca: g.marca, produtos: g.produtos }));
    subgrupos.forEach(({ marca, produtos }) => {
      if (marca) blocos.push({ tipo: "marca", texto: String(marca), h: 22 });
      const cards = produtos.map((p) => montarCard(med, H, p));
      for (let i = 0; i < cards.length; i += 2) {
        const par = cards.slice(i, i + 2);
        const altura = Math.max(...par.map((c) => c.h));
        blocos.push({ tipo: "linha", par, h: altura + GAP_Y, altura });
      }
    });
  });
  return blocos;
}

function dividirEmPartes(blocos) {
  const partes = [];
  let atual = null;
  const nova = (primeira) => {
    atual = { blocos: [], y: primeira ? CABECALHO_H + 10 : 20, primeira };
    partes.push(atual);
  };
  nova(true);
  blocos.forEach((b, i) => {
    const reserva = RODAPE_H + 30;
    if (atual.blocos.length && atual.y + b.h + reserva > ALTURA_MAX_PARTE) nova(false);
    // categoria/marca não ficam órfãs no fim de uma parte: se o próximo bloco é uma linha, quebra antes.
    atual.blocos.push({ ...b, y: atual.y });
    atual.y += b.h;
  });
  const ultima = partes[partes.length - 1];
  ultima.altura = ultima.y + 24 + RODAPE_H;
  ultima.ultima = true;
  partes.forEach((p) => { if (!p.ultima) p.altura = p.y + 10; });
  return partes;
}

function desenharCabecalho(doc, titulo) {
  doc.image(IMG_CABECALHO, 0, 0, { width: LARGURA, height: CABECALHO_H });
  doc.image(IMG_LOGO, 31.7, 7.8, { width: 41.8 });
  let fonte = 33;
  doc.font(F.extraItalico[0]);
  while (fonte > 14 && doc.fontSize(fonte).widthOfString(titulo) > 388) fonte -= 0.5;
  doc.fillColor("#ffffff").font(F.extraItalico[0]).fontSize(fonte)
    .text(titulo, 92.2, 7.6 + (33 - fonte) * 0.55, { width: 392, lineBreak: false });
  doc.fillColor(TEXTO).font("Helvetica");
}

async function gerarPdfCatalogoContinuo(produtos, fabricante, destino, H, opcoes = {}) {
  const agruparPorMarca = Boolean(opcoes.agruparPorMarca);
  const med = new PDFDocument({ size: [LARGURA, 200], margin: 0 });
  registrar(med);
  med.on("data", () => {});

  const grupos = agruparPorMarca
    ? H._agruparPorMarca(produtos).map(({ marca, produtos: itens }) => ({ linha: marca, itens }))
    : H._agruparPorLinha(produtos);
  const blocos = planejar(med, H, grupos, agruparPorMarca);
  const partes = dividirEmPartes(blocos);
  med.end();

  const doc = new PDFDocument({ size: [LARGURA, 200], margin: 0, autoFirstPage: false });
  doc.pipe(destino);
  registrar(doc);

  const titulo = fabricante && !/diversos/i.test(String(fabricante)) ? `Catálogo ${String(fabricante).toUpperCase()}` : "Catálogo de Produtos";

  for (const parte of partes) {
    doc.addPage({ size: [LARGURA, Math.ceil(parte.altura)], margin: 0 });
    if (parte.primeira) desenharCabecalho(doc, titulo);
    for (const b of parte.blocos) {
      if (b.tipo === "categoria") {
        doc.lineWidth(0.8).strokeColor(LINHA_CATEGORIA)
          .moveTo(CATEGORIA_X, b.y + 14).lineTo(LARGURA - CATEGORIA_X, b.y + 14).stroke();
        doc.fillColor(AZUL).font(F.negrito[0]).fontSize(15)
          .text(b.texto, CATEGORIA_X, b.y + 14 + 12, { width: LARGURA - CATEGORIA_X * 2, lineBreak: false, ellipsis: true });
      } else if (b.tipo === "marca") {
        doc.fillColor(AZUL_MARINHO).font(F.semiItalico[0]).fontSize(11)
          .text(b.texto, MARGEM_X, b.y + 3, { width: LARGURA - MARGEM_X * 2, lineBreak: false, ellipsis: true });
      } else {
        b.par.forEach((card, i) => desenharCard(doc, H, card, MARGEM_X + i * (CARD_W + GAP_X), b.y, b.altura));
        // eslint-disable-next-line no-await-in-loop
        await H._cederEventLoop();
      }
    }
    if (parte.ultima) doc.image(IMG_RODAPE, 0, Math.ceil(parte.altura) - RODAPE_H, { width: LARGURA, height: RODAPE_H });
  }

  doc.end();
  return new Promise((resolve, reject) => {
    destino.on("finish", resolve);
    destino.on("error", reject);
  });
}

module.exports = { gerarPdfCatalogoContinuo };
