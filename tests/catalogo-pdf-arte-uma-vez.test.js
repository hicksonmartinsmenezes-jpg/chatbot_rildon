'use strict';

// catalogo-rildon#63: o pdfkit só reaproveita uma imagem quando ela é passada como
// CAMINHO — o cache _imageRegistry dele é consultado apenas `if (typeof src
// === "string")`. As artes do catálogo são Buffer, lidas uma vez no topo do
// módulo, então `doc.image(CABECALHO_IMG, ...)` gravava outra cópia inteira do
// PNG dentro do PDF em TODA página: ~0,6 MB e ~0,4 s por página (medido, com a
// arte do Completo: 20 páginas davam 15,31 MB em 8,8 s contra 0,77 MB em
// 0,47 s). O helper _arte abre cada arte uma vez por documento (doc.openImage)
// e devolve sempre o mesmo objeto.
//
// Este teste usa o gerador PROMOCIONAL de propósito, e não o Completo: ele
// desenha cabeçalho e rodapé por página do mesmo jeito, mas com artes pequenas
// (7-59 KB em vez do cabeçalho de 5752x1168), o que deixa a suíte na casta do
// segundo em vez de ~70 s no runner do CI.
//
// Espera o 'finish' do stream antes de terminar: gerarPdfCatalogoPromocional
// chama doc.end() e volta, mas embutir as artes e comprimir as páginas
// acontece depois (ver catalogo-rildon#61) — sem esperar, esse trabalho vaza para a suíte
// seguinte.

const { Writable } = require('stream');

jest.mock('../src/services/catalogo-fotos.service', () => ({
  obterFoto: jest.fn(() => null),
  listarFotos: jest.fn(() => []),
  temMultiplasFotos: jest.fn(() => false),
  temAlgumaFoto: jest.fn(() => true),
  obterVersaoFotos: jest.fn(() => 1),
}));
jest.mock('../src/services/catalogo-x2.service', () => ({
  listarMarcasVeiculoConhecidas: jest.fn(() => []),
}));

const PDFDocument = require('pdfkit');
const { gerarPdfCatalogoPromocional } = require('../src/services/catalogo-pdf.service');

// Fabricantes diferentes: no modo "fabricante" cada grupo começa em página
// nova, então a arte de cabeçalho/rodapé é desenhada em mais de uma página —
// que é a condição que o teste precisa.
const produtos = [
  { codigo: '1', nome: 'PRODUTO A', fabricante: 'CHEVROLET', equivalentes: [] },
  { codigo: '2', nome: 'PRODUTO B', fabricante: 'FIAT', equivalentes: [] },
  { codigo: '3', nome: 'PRODUTO C', fabricante: 'ZM', equivalentes: [] },
];

test('nenhuma arte é reaberta a cada página', async () => {
  // Conta por IDENTIDADE do Buffer: duas imagens diferentes podem ter o mesmo
  // número de bytes, então contar por tamanho daria falso positivo.
  const aberturas = new Map();
  let paginas = 0;
  const openOriginal = PDFDocument.prototype.openImage;
  const addPageOriginal = PDFDocument.prototype.addPage;
  PDFDocument.prototype.openImage = function espiarOpenImage(src) {
    if (Buffer.isBuffer(src)) aberturas.set(src, (aberturas.get(src) || 0) + 1);
    return openOriginal.apply(this, arguments);
  };
  PDFDocument.prototype.addPage = function contarPagina() {
    paginas += 1;
    return addPageOriginal.apply(this, arguments);
  };

  const destino = new Writable({ write(_c, _e, cb) { cb(); } });
  const escrito = new Promise((resolve, reject) => {
    destino.on('finish', resolve);
    destino.on('error', reject);
  });
  try {
    await gerarPdfCatalogoPromocional(produtos, new Map(), destino, 'fabricante', {});
    await escrito;
  } finally {
    PDFDocument.prototype.openImage = openOriginal;
    PDFDocument.prototype.addPage = addPageOriginal;
  }

  // Sanidade: sem mais de uma página, e sem nenhuma arte, o teste não diria
  // nada. Antes do conserto, cada arte apareceria uma vez por página.
  expect(paginas).toBeGreaterThan(1);
  expect(aberturas.size).toBeGreaterThan(0);

  const reabertas = [...aberturas.values()].filter((vezes) => vezes > 1);
  expect(reabertas).toEqual([]);
}, 30000);
