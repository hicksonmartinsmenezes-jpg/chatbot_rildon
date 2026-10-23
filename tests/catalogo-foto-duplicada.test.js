'use strict';

/**
 * BUG REAL reportado pelo usuário em 2026-10-23: "verifique em consultar,
 * ainda temos fotos duplicadas". Medido ao vivo no acervo real: de 300
 * produtos que o Consultar mostrava com 2 fotos, 13% exibiam a MESMA imagem
 * nas duas posições — metade porque o X2 guarda a foto cheia e uma miniatura
 * dela como arquivos separados.
 *
 * Aqui fica o critério em si (o mesmo que o PDF do catálogo usa desde antes,
 * agora compartilhado). As imagens são JPEGs de verdade, geradas na hora.
 */

const jpeg = require('jpeg-js');
const { ehMesmaFoto, escolherSemRepetidas } = require('../src/services/catalogo-foto-duplicada');

// Gera um JPEG com um quadrado escuro no canto superior esquerdo — o mesmo
// desenho em qualquer tamanho, que é exatamente o caso "foto e sua miniatura".
function jpegDesenho(largura, altura, { invertido = false } = {}) {
  const data = Buffer.alloc(largura * altura * 4);
  for (let y = 0; y < altura; y += 1) {
    for (let x = 0; x < largura; x += 1) {
      const dentro = x < largura / 2 && y < altura / 2;
      const escuro = invertido ? !dentro : dentro;
      const i = (y * largura + x) * 4;
      const v = escuro ? 20 : 230;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width: largura, height: altura }, 85).data;
}

function foto(nome, largura, altura, opcoes) {
  return { nome, buffer: jpegDesenho(largura, altura, opcoes), mimetype: 'image/jpeg', largura, altura, chave: nome };
}

describe('mesma foto?', () => {
  test('bytes idênticos são a mesma foto', () => {
    const a = foto('0.jpg', 224, 224);
    const b = { ...a, nome: 'copia.jpg', chave: 'copia.jpg' };
    expect(ehMesmaFoto(a, b)).toBe(true);
  });

  test('miniatura do X2 (150px) é a mesma foto da versão cheia', () => {
    expect(ehMesmaFoto(foto('cheia.jpg', 224, 224), foto('mini.jpg', 150, 150))).toBe(true);
  });

  test('miniatura de uma foto grande também é pega', () => {
    expect(ehMesmaFoto(foto('cheia.jpg', 1200, 1200), foto('mini.jpg', 150, 150))).toBe(true);
  });

  test('duas fotos do mesmo tamanho NÃO são a mesma (vistas diferentes da peça)', () => {
    expect(ehMesmaFoto(foto('frente.jpg', 400, 400), foto('tras.jpg', 400, 400, { invertido: true }))).toBe(false);
  });

  test('proporções diferentes NÃO são a mesma foto', () => {
    expect(ehMesmaFoto(foto('quadrada.jpg', 400, 400), foto('larga.jpg', 150, 60))).toBe(false);
  });

  test('sem dimensão conhecida, não arrisca esconder', () => {
    const a = foto('a.jpg', 400, 400);
    expect(ehMesmaFoto(a, { nome: 'b.jpg', buffer: Buffer.from('nao e imagem'), mimetype: 'image/jpeg', largura: null, altura: null })).toBe(false);
  });

  test('imagens grandes e parecidas sem miniatura: decide pela impressão digital', () => {
    // 500 vs 800: a menor passa de 160px, então entra o aHash — mesmo desenho, mesma foto.
    expect(ehMesmaFoto(foto('m.jpg', 500, 500), foto('g.jpg', 800, 800))).toBe(true);
    expect(ehMesmaFoto(foto('m.jpg', 500, 500), foto('g2.jpg', 800, 800, { invertido: true }))).toBe(false);
  });
});

describe('o que sai da lista', () => {
  test('fica a de maior resolução e some a miniatura', () => {
    const esconder = escolherSemRepetidas([foto('mini.jpg', 150, 150), foto('cheia.jpg', 224, 224), foto('outra.jpg', 400, 400, { invertido: true })]);
    expect([...esconder]).toEqual(['mini.jpg']);
  });

  test('lista sem repetição não perde nada', () => {
    const esconder = escolherSemRepetidas([foto('a.jpg', 400, 400), foto('b.jpg', 400, 400, { invertido: true })]);
    expect(esconder.size).toBe(0);
  });

  test('três cópias da mesma foto deixam só uma', () => {
    const esconder = escolherSemRepetidas([foto('p.jpg', 150, 150), foto('m.jpg', 224, 224), foto('g.jpg', 600, 600)]);
    expect(esconder.size).toBe(2);
    expect(esconder.has('g.jpg')).toBe(false); // fica a maior
  });
});
