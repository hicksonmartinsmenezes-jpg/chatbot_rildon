'use strict';

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
const { gerarPdfCatalogoPromocional, carregarLogoPromocional } = require('../src/services/catalogo-pdf.service');

const produtos = [
  { codigo: '1', nome: 'PRODUTO A', fabricante: 'CHEVROLET', equivalentes: [] },
  { codigo: '2', nome: 'PRODUTO B', fabricante: '', equivalentes: [] },
  { codigo: '3', nome: 'PRODUTO C', fabricante: 'ZM', equivalentes: [] },
];

async function gerar(opcoes) {
  const textos = [];
  let imagens = 0;
  const textOriginal = PDFDocument.prototype.text;
  const imageOriginal = PDFDocument.prototype.image;
  PDFDocument.prototype.text = function (t) { textos.push(String(t)); return textOriginal.apply(this, arguments); };
  PDFDocument.prototype.image = function () { imagens += 1; return imageOriginal.apply(this, arguments); };
  try {
    const destino = new Writable({ write(_c, _e, cb) { cb(); } });
    await gerarPdfCatalogoPromocional(produtos, new Map(), destino, 'fabricante', opcoes);
  } finally {
    PDFDocument.prototype.text = textOriginal;
    PDFDocument.prototype.image = imageOriginal;
  }
  return { texto: textos.join('|'), imagens };
}

test('sem título fixo, cabeçalho continua com o nome de cada grupo', async () => {
  const { texto } = await gerar({});
  expect(texto).toContain('CHEVROLET');
  expect(texto).toContain('SEM FABRICANTE IDENTIFICADO');
});

test('com título fixo, só aparece "PROMOCIONAL" e nenhum nome de grupo', async () => {
  const { texto } = await gerar({ titulo: 'Promocional' });
  expect(texto).toContain('PROMOCIONAL');
  expect(texto).not.toContain('CHEVROLET');
  expect(texto).not.toContain('SEM FABRICANTE IDENTIFICADO');
});

test('logo é desenhada no cabeçalho quando informada', async () => {
  const logo = carregarLogoPromocional('zm');
  expect(Buffer.isBuffer(logo)).toBe(true);
  const sem = await gerar({ titulo: 'Promocional' });
  const com = await gerar({ titulo: 'Promocional', logo });
  expect(com.imagens).toBe(sem.imagens + 1);
});

test('carregarLogoPromocional rejeita chave fora da lista e caminhos', () => {
  expect(carregarLogoPromocional('../../.env')).toBeNull();
  expect(carregarLogoPromocional('naoexiste')).toBeNull();
  expect(carregarLogoPromocional('')).toBeNull();
});
