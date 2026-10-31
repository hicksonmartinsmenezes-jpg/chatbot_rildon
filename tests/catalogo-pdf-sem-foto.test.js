'use strict';

const { Writable } = require('stream');
const mockObterFoto = jest.fn();

jest.mock('../src/services/catalogo-fotos.service', () => ({
  obterFoto: (...args) => mockObterFoto(...args),
  listarFotos: jest.fn(() => []),
  temMultiplasFotos: jest.fn(() => false),
  temAlgumaFoto: jest.fn(() => true),
  obterVersaoFotos: jest.fn(() => 1),
}));

jest.mock('../src/services/catalogo-x2.service', () => ({
  listarMarcasVeiculoConhecidas: jest.fn(() => []),
}));

const PDFDocument = require('pdfkit');
const jpeg = require('jpeg-js');
const { gerarPdfCatalogoCompleto, limparCacheBboxFotos } = require('../src/services/catalogo-pdf.service');

function jpegTeste() {
  const data = Buffer.alloc(16 * 16 * 4, 255);
  return jpeg.encode({ data, width: 16, height: 16 }, 85).data;
}

test('catálogo completo omite produto sem foto utilizável antes de montar o índice', async () => {
  const fotoValida = { buffer: jpegTeste(), mimetype: 'image/jpeg' };
  mockObterFoto.mockImplementation((codigo, indice) => {
    if (indice !== 0) return null;
    return codigo === 'COM-FOTO' ? fotoValida : null;
  });
  limparCacheBboxFotos();

  const textos = [];
  const textOriginal = PDFDocument.prototype.text;
  PDFDocument.prototype.text = function capturarTexto(texto) {
    textos.push(String(texto));
    return textOriginal.apply(this, arguments);
  };

  try {
    const produtos = [
      { codigo: 'SEM-FOTO', nome: 'MARCADOR-PRODUTO-SEM-FOTO', linha: 'TESTE', equivalentes: [] },
      { codigo: 'COM-FOTO', nome: 'MARCADOR-PRODUTO-COM-FOTO', linha: 'TESTE', equivalentes: [] },
    ];
    const destino = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    await gerarPdfCatalogoCompleto(produtos, 'TESTE', destino);

    expect(textos.join(' ')).toContain('MARCADOR-PRODUTO-COM-FOTO');
    expect(textos.join(' ')).not.toContain('MARCADOR-PRODUTO-SEM-FOTO');
    expect(textos.join(' ')).not.toContain('sem foto');
  } finally {
    PDFDocument.prototype.text = textOriginal;
  }
});
