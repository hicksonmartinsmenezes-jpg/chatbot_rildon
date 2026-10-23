'use strict';

/**
 * BUG REAL (2026-10-23): o mesmo arquivo de foto aparecia DUAS vezes na lista
 * do produto quando estava em dois zips diferentes — conferido no servidor,
 * o produto 109356 tinha "0.jpg" duas vezes, byte a byte igual, e o card do
 * Consultar mostrava a peça repetida. O índice agora é montado por nome de
 * arquivo dentro de cada código.
 */

const { _montarIndice } = require('../src/services/catalogo-fotos.service');

const zip = (caminho, nomes) => ({ zipPath: caminho, entradas: nomes.map(name => ({ name })) });

describe('índice de fotos', () => {
  test('mesmo arquivo em dois zips entra uma vez só', () => {
    const { porCodigo, repetidas } = _montarIndice([
      zip('/fotos/velho.zip', ['109356/0.jpg', '109356/1013.jpg']),
      zip('/fotos/novo.zip', ['109356/0.jpg']),
    ]);
    const lista = porCodigo.get('109356').map(i => i.entrada.name);
    expect(lista).toEqual(['109356/0.jpg', '109356/1013.jpg']);
    expect(repetidas).toBe(1);
  });

  test('o zip mais novo (último da lista) é quem vale', () => {
    const { porCodigo } = _montarIndice([
      zip('/fotos/velho.zip', ['109356/0.jpg']),
      zip('/fotos/novo.zip', ['109356/0.jpg']),
    ]);
    expect(porCodigo.get('109356')[0].zipPath).toBe('/fotos/novo.zip');
  });

  test('arquivos diferentes do mesmo produto continuam todos', () => {
    const { porCodigo, repetidas } = _montarIndice([zip('/fotos/a.zip', ['111/0.jpg', '111/1.jpg', '222/0.jpg'])]);
    expect(porCodigo.get('111')).toHaveLength(2);
    expect(porCodigo.get('222')).toHaveLength(1);
    expect(repetidas).toBe(0);
  });

  test('entrada sem código (sem barra) é ignorada', () => {
    const { porCodigo } = _montarIndice([zip('/fotos/a.zip', ['leiame.txt', '/0.jpg', '111/0.jpg'])]);
    expect([...porCodigo.keys()]).toEqual(['111']);
  });
});
