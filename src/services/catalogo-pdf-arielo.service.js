/**
 * Catálogo "Estilo Arielo" — layout específico copiado do catálogo do próprio
 * fabricante (Arielo.pdf, 2026-10-01): grade 4×4, logo do fabricante no topo,
 * card com moldura dupla (ciano + fio preto), caixa azul com o código da
 * FAMÍLIA (ex.: EST349), tipo da peça ao lado, código original em vermelho,
 * foto e aplicação embaixo, e — em toda página — a "Tabela de referências do
 * Grupo Arielo" (ARIELO / A.R. / LIDER / MA), com os códigos que a Rildon
 * vende destacados em vermelho.
 *
 * Reaproveita cabeçalho/rodapé/índice/foto do gerador padrão
 * (catalogo-pdf.service.js → _interno): é o mesmo desenhista e o mesmo
 * conjunto de fontes, então as páginas "casam" com o resto dos catálogos.
 */
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const LOGO_ARIELO = fs.readFileSync(path.join(__dirname, "../assets/catalogo-arielo-logo.png"));
const LOGO_RATIO = 565 / 353;

// Prefixo de 3 dígitos do código do Grupo Arielo → marca (ordem da tabela).
const MARCAS_GRUPO = [
  { pref: "800", nome: "ARIELO" },
  { pref: "702", nome: "A.R." },
  { pref: "600", nome: "LIDER" },
  { pref: "202", nome: "MA" },
];
const PREFIXOS_VALIDOS = new Set(MARCAS_GRUPO.map((m) => m.pref));

const COLS = 4;
const ROWS = 4;
const POR_PAGINA = COLS * ROWS;
const MARGEM = 10;
const GAP_X = 5;
const GAP_Y = 7;
const CARD_H = 118;
const CARDS_Y0 = 158;

const CIANO = "#00afef";
const AZUL_CODIGO = "#005aaa";
const VERMELHO = "#dc2626";
const AMARELO_MARCA = "#ffec00";

// "EST 600349" / "IND600057" / "VIND600057" → { tipo:"EST", prefixo:"600", numero:"349" }
function parsearCodigoGrupo(nome) {
  const texto = String(nome || "").toUpperCase();
  const todos = [...texto.matchAll(/\b([A-Z]{2,4})\s?(\d{3})(\d{3})\b/g)];
  for (let i = todos.length - 1; i >= 0; i -= 1) {
    let [, tipo, pref, numero] = todos[i];
    if (!PREFIXOS_VALIDOS.has(pref)) continue;
    if (tipo.length === 4 && tipo.startsWith("V")) tipo = tipo.slice(1); // variante "VIND…"
    return { tipo, prefixo: pref, numero };
  }
  return null;
}

function plural(linha) {
  const t = String(linha || "").trim().toUpperCase();
  if (!t) return "PRODUTOS";
  if (t.endsWith("S")) return t;
  return /[RZ]$/.test(t) ? `${t}ES` : `${t}S`;
}

function tituloCapitalizado(texto) {
  return String(texto || "")
    .toLowerCase()
    .replace(/(^|[\s/(,.-])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase())
    .replace(/\b(\w*\d\w*)\b/g, (m) => m.toUpperCase())
    .replace(/\b([a-zA-Z]{1,2})\b/g, (m) => m.toUpperCase());
}

function descricaoCurta(produto) {
  let d = String(produto.nome || "").split(" - ")[0];
  d = d.replace(/\*[^*]*\*/g, " "); // *NCP* *S/G* *IND*
  d = d.replace(/^(ESTATOR|INDUZIDO|ROTOR|BOBINA|REGULADOR)(\s+(ALT\.?|DE PARTIDA|PARTIDA|DE ALTERNADOR))?\s*/i, "");
  d = d.replace(/\s+/g, " ").trim();
  return tituloCapitalizado(d);
}

function codigoOriginal(produto) {
  const eq = Array.isArray(produto.equivalentes) ? produto.equivalentes : [];
  const primeiro = eq[0];
  if (!primeiro) return "";
  return String(typeof primeiro === "object" ? primeiro.codigo || primeiro.numero || "" : primeiro).trim();
}

// Agrupa os produtos de UMA linha em "famílias" (um card por família).
function montarFamilias(itens) {
  const mapa = new Map();
  const avulsos = [];
  for (const p of itens) {
    const info = parsearCodigoGrupo(p.nome);
    if (!info) { avulsos.push(p); continue; }
    const chave = `${info.tipo}${info.numero}`;
    if (!mapa.has(chave)) mapa.set(chave, { rotulo: chave, tipo: info.tipo, numero: info.numero, membros: new Map() });
    mapa.get(chave).membros.set(info.prefixo, p);
  }
  const familias = [...mapa.values()].sort((a, b) => a.rotulo.localeCompare(b.rotulo, "pt-BR", { numeric: true }));
  for (const p of avulsos) {
    const rotulo = String(p.referencia || p.codigo).split(" - ")[0].replace(/\s+/g, "");
    // rótulo no padrão TIPO+3 dígitos (ex.: EST398) também entra na tabela de referências
    const m = /^([A-Z]{2,4})(\d{3})$/.exec(rotulo);
    familias.push({ rotulo, tipo: m ? m[1] : "", numero: m ? m[2] : null, membros: new Map([["", p]]) });
  }
  // ordem crescente pelo código da família (EST270, EST274, … como no catálogo original)
  familias.sort((a, b) => String(a.rotulo).localeCompare(String(b.rotulo), "pt-BR", { numeric: true }));
  return familias;
}

function representante(familia) {
  for (const m of MARCAS_GRUPO) {
    const p = familia.membros.get(m.pref) || null;
    if (p) return p;
  }
  return [...familia.membros.values()][0];
}

async function gerarPdfCatalogoArielo(produtos, fabricante, destino, helpers) {
  const H = helpers;
  // 2026-10-09 (auditoria): sem `bufferPages: true` — com ela o pdfkit segura
  // TODAS as páginas em memória e só no doc.end() roda um deflateSync por
  // página de uma vez, travando o event loop por segundos no fim da geração.
  // Este gerador não usa doc.switchToPage(), que é a única coisa que exigiria
  // a flag. Mesma mudança feita em catalogo-pdf.service.js.
  const doc = new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false });
  doc.pipe(destino);
  doc.registerFont(H.TITULO_FONTE, H.TITULO_FONTE_ARQUIVO);
  doc.registerFont(H.RODAPE_NUMERO_FONTE, H.RODAPE_NUMERO_FONTE_ARQUIVO);
  doc.registerFont("Quicksand-Bold", path.join(__dirname, "..", "assets", "fonts", "Quicksand-Bold.ttf"));
  doc.registerFont("Quicksand-Medium", path.join(__dirname, "..", "assets", "fonts", "Quicksand-Medium.ttf"));
  doc.registerFont("Bebas", path.join(__dirname, "..", "assets", "fonts", "BebasNeue-Bold.ttf"));

  const grupos = H._agruparPorLinha(produtos).map(({ linha, itens }) => {
    const familias = montarFamilias(itens);
    return { linha, titulo: plural(linha), familias, paginas: Math.max(1, Math.ceil(familias.length / POR_PAGINA)) };
  });

  // --- paginação do índice (1 página basta para as ~3-10 seções de um fabricante) ---
  const areaTopoIndice = H.INDICE_HEADER_HEIGHT + H.INDICE_TITULO_GAP_TOPO + H.INDICE_TITULO_TAMANHO + H.INDICE_TITULO_GAP_LINHAS;
  const linhasPorPaginaIndice = Math.max(1, Math.floor((H.A4_ALTURA - H.FOOTER_HEIGHT - 8 - areaTopoIndice) / H.INDICE_LINHA_ALTURA));
  const paginasIndice = Math.max(1, Math.ceil(grupos.length / linhasPorPaginaIndice));
  // fluxo contínuo: as linhas de produto seguem umas nas outras, sem deixar vagas no fim
  // de uma linha (os primeiros itens da linha seguinte ocupam o resto da página)
  const fluxo = [];
  grupos.forEach((g) => { g.paginaInicial = paginasIndice + 1 + Math.floor(fluxo.length / POR_PAGINA); g.familias.forEach((f) => fluxo.push({ f, g })); });

  let pagina = 0;
  const desenharLogo = () => {
    const w = 100;
    doc.image(LOGO_ARIELO, 54, 27, { width: w, height: w / LOGO_RATIO });
  };

  for (let p = 0; p < paginasIndice; p += 1) {
    doc.addPage();
    pagina += 1;
    H._desenharCabecalhoIndice(doc, "eletrica", fabricante);
    desenharLogo();
    H._desenharRodape(doc, pagina, "eletrica");
    const offset = p * linhasPorPaginaIndice;
    let y = areaTopoIndice;
    grupos.slice(offset, offset + linhasPorPaginaIndice).forEach((g) => {
      H._desenharLinhaIndice(doc, g.titulo, g.paginaInicial, y, H.A4_LARGURA - H.PAGE_MARGIN * 2);
      y += H.INDICE_LINHA_ALTURA;
    });
  }

  for (let off = 0; off < fluxo.length; off += POR_PAGINA) {
    const fatia = fluxo.slice(off, off + POR_PAGINA);
    doc.addPage();
    pagina += 1;
    H._desenharCabecalho(doc, fatia[0].g.titulo, "eletrica", fabricante);
    desenharLogo();
    const familiasPagina = fatia.map((x) => x.f);
    const { geo, tabelaTopo } = geometriaPagina(doc, H);
    await desenharGrade(doc, H, familiasPagina, geo);
    if (familiasPagina.some((f) => f.numero != null)) desenharTabelaReferencias(doc, H, familiasPagina, tabelaTopo);
    H._desenharRodape(doc, pagina, "eletrica");
    await H._cederEventLoop();
  }

  doc.end();
  return new Promise((resolve, reject) => {
    destino.on("finish", resolve);
    destino.on("error", reject);
  });
}

// Altura reservada à tabela de referências (título + 4 linhas) no pé da página.
const TABELA_ALTURA_TOTAL = 36 + 104 + 6;
const TABELA_GAP_CARDS = 8;

function geometriaPagina(doc, H) {
  const tabelaTopo = H.A4_ALTURA - H.FOOTER_HEIGHT - 6 - TABELA_ALTURA_TOTAL;
  const areaFimY = tabelaTopo - TABELA_GAP_CARDS;
  const geo = H._geometriaGrid(doc, COLS, ROWS, true, { areaTopoY: H.AREA_TOPO_Y, areaFimY });
  return { geo, tabelaTopo };
}

async function desenharGrade(doc, H, familias, geo) {
  for (let i = 0; i < familias.length; i += 1) {
    const familia = familias[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = H.PAGE_MARGIN + col * (geo.cardWidth + H.GAP);
    const y = geo.areaTopoY + row * (geo.cardHeight + H.GAP);
    // Card IDÊNTICO ao do catálogo elétrica (selo, OEM, 1-2 fotos, resumo e
    // aplicação) — só o rótulo do selo é o código da FAMÍLIA.
    const base = representante(familia);
    // aplicação: a organizada pela IA (se houver, em qualquer membro da família); senão a do cadastro
    const membros = [...familia.membros.values()];
    const organizada = base.aplicacaoOrganizada || (membros.find((m) => m.aplicacaoOrganizada) || {}).aplicacaoOrganizada;
    const crua = String(base.aplicacao || (membros.find((m) => m.aplicacao) || {}).aplicacao || "").replace(/\s+/g, " ").trim();
    const rep = { ...base, aplicacaoOrganizada: organizada || crua || undefined, _rotuloOverride: familia.rotulo };
    H._desenharCardVidro(doc, x, y, geo.cardWidth, geo.cardHeight);
    H._desenharCardCatalogoCompleto(doc, rep, x, y, geo.cardWidth, geo.cardHeight, geo.photoBoxWidth, geo.photoBoxHeight, null, null, "eletrica");
    // cede o event loop a cada card (como o catálogo original) pra não travar WhatsApp/painel/banco
    await H._cederEventLoop();
  }
  // completa a página inteira (4x4) com cards vazios, mesma moldura do card real
  for (let i = familias.length; i < POR_PAGINA; i += 1) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    H._desenharCardVazio(doc, H.PAGE_MARGIN + col * (geo.cardWidth + H.GAP), geo.areaTopoY + row * (geo.cardHeight + H.GAP), geo.cardWidth, geo.cardHeight);
  }
  doc.fillColor("#111827").font("Helvetica");
}

// texto sans condensado (Helvetica espremida na horizontal), como a tabela original
function textoCond(doc, txt, x, y, w, size, bold, cor, esc = 0.78, align = "center") {
  doc.save();
  doc.translate(align === "center" ? x + w / 2 : x, y).scale(esc, 1);
  doc.fillColor(cor).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
  if (align === "center") doc.text(txt, -w / 2 / esc, 0, { width: w / esc, align: "center", lineBreak: false });
  else doc.text(txt, 0, 0, { lineBreak: false });
  doc.restore();
}

function desenharTabelaReferencias(doc, H, familias, yTopo) {
  const x0 = MARGEM;
  const largura = H.A4_LARGURA - MARGEM * 2;
  const alturaTitulo = 36;
  const alturaTab = 104;
  const alturaFrame = alturaTitulo + alturaTab + 4;

  // moldura ciano arredondada (envolve título + tabela)
  doc.lineWidth(3).strokeColor(CIANO).roundedRect(x0, yTopo, largura, alturaFrame, 4).stroke();

  // título + OBS centralizados
  doc.fillColor("#111827").font("Bebas").fontSize(18)
    .text("TABELA DE REFERÊNCIAS DO GRUPO ARIELO", x0, yTopo + 4, { width: largura, align: "center", lineBreak: false });
  const obs1 = "OBS: ";
  const obs2 = "Referências em vermelho indicam produtos equivalentes, do Grupo Arielo, à venda na Rildon Eletropeças.";
  doc.font("Helvetica-Bold").fontSize(6);
  const w1 = doc.widthOfString(obs1);
  doc.font("Helvetica").fontSize(6);
  const w2 = doc.widthOfString(obs2);
  const xo = x0 + (largura - (w1 + w2)) / 2;
  doc.font("Helvetica-Bold").fontSize(6).fillColor(VERMELHO).text(obs1, xo, yTopo + 24, { lineBreak: false });
  doc.font("Helvetica").fontSize(6).fillColor("#111827").text(obs2, xo + w1, yTopo + 24, { lineBreak: false });

  const yTab = yTopo + alturaTitulo;
  const xTab = x0 + 3;
  const larguraTab = largura - 6;
  const larguraLabel = alturaTab * 307 / 555;
  const larguraCol = (larguraTab - larguraLabel) / POR_PAGINA;
  const faixas = [[0, 135], [135, 275], [275, 411], [411, 555]].map(([a, b]) => [a / 555 * alturaTab, b / 555 * alturaTab]);

  doc.image(path.join(__dirname, "..", "assets", "catalogo-arielo-marcas.png"), xTab, yTab, { width: larguraLabel, height: alturaTab });
  // grade fina cinza (linhas e colunas), como a tabela original
  doc.lineWidth(0.4).strokeColor("#b8bec6");
  faixas.forEach(([fy0]) => doc.moveTo(xTab + larguraLabel, yTab + fy0).lineTo(xTab + larguraLabel + POR_PAGINA * larguraCol, yTab + fy0).stroke());
  doc.moveTo(xTab + larguraLabel, yTab + alturaTab).lineTo(xTab + larguraLabel + POR_PAGINA * larguraCol, yTab + alturaTab).stroke();
  for (let c = 0; c <= POR_PAGINA; c += 1) {
    const xc = xTab + larguraLabel + c * larguraCol;
    doc.moveTo(xc, yTab).lineTo(xc, yTab + alturaTab).stroke();
  }

  MARCAS_GRUPO.forEach((marca, r) => {
    const [fy0, fy1] = faixas[r];
    const yLinha = yTab + fy0;
    const altura = fy1 - fy0;
    familias.forEach((familia, c) => {
      if (familia.numero == null) return;
      const xCol = xTab + larguraLabel + c * larguraCol;
      const codigo = `${familia.tipo}${marca.pref}${familia.numero}`;
      const vendemos = familia.membros.has(marca.pref);
      const cor = vendemos ? VERMELHO : "#8d949d";
      doc.fillColor(cor).font("Bebas").fontSize(7.4).text(codigo, xCol, yLinha + altura / 2 - 3.4, { width: larguraCol, align: "center", lineBreak: false });
    });
  });
  doc.fillColor("#111827").font("Helvetica");
}

module.exports = { gerarPdfCatalogoArielo, parsearCodigoGrupo, montarFamilias };
