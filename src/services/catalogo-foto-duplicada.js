// Critério único de "estas duas fotos são a MESMA foto".
//
// Vive num módulo próprio porque DOIS caminhos precisam da mesma resposta e
// precisam concordar entre si: o PDF do catálogo (card com 2 fotos lado a
// lado, ver catalogo-pdf.service.js) e a consulta do programa da loja (card
// do Consultar + /api/catalogo/produtos/:codigo/fotos/:indice, ver
// catalogo-fotos.service.js). Até 2026-10-23 só o PDF deduplicava; o
// Consultar mostrava a mesma peça duas vezes.
//
// Levantamento ao vivo (2026-10-23, 300 produtos do acervo real que o
// Consultar mostrava com 2 fotos): 13% exibiam a MESMA imagem nas duas
// posições. Duas origens bem diferentes:
//   1. o MESMO arquivo indexado de dois zips distintos (ex.: 109356 com
//      "0.jpg" duas vezes, byte a byte igual) — resolvido no índice, sem
//      ler foto nenhuma (ver _montarIndice em catalogo-fotos.service.js);
//   2. o X2 guarda a foto cheia E uma miniatura dela como arquivos
//      separados (ex.: 109811 com 150x150 e 224x224 da mesma peça) — é o
//      que este módulo resolve.
//
// Critério (conferido em 10 pares reais quando o PDF foi escrito, mantido
// aqui): bytes iguais; OU mesma proporção (±4%) com uma pelo menos 1,4x
// maior que a outra (a menor é a miniatura). Só o tamanho não basta e só a
// impressão digital também não — duas VISTAS diferentes da mesma peça
// (frente/traseira de um alternador) ficam a 3 bits uma da outra, mas vêm
// na mesma resolução, e é a razão de tamanho que as separa.
const jpeg = require("jpeg-js");

const TOLERANCIA_ASPECTO = 0.04;
const RAZAO_MINIATURA = 1.4;
const HAMMING_MAX = 8;
// A miniatura do X2 sai em 150px (150x150, 150x139, 132x150... em todos os
// pares reais examinados). Abaixo deste limite, proporção + razão de tamanho
// já decidem sozinhas e o decode é dispensado — é o que mantém a varredura
// do acervo inteiro barata (o decode de um JPEG 3088x3088 passa de 300ms).
const MINIATURA_MAX_DIM = 160;
// Acima disto o decode custa caro demais para o ganho: na dúvida, trata como
// fotos diferentes (mostrar duas fotos parecidas é bem menos ruim do que
// esconder uma foto de verdade).
const AHASH_MAX_DIM = 1600;

const cacheAhash = new Map();

function _ahash(foto) {
  const chave = foto.chave;
  if (chave && cacheAhash.has(chave)) return cacheAhash.get(chave);
  let bits;
  try {
    const im = jpeg.decode(foto.buffer, { useTArray: true, maxMemoryUsageInMB: 256 });
    const cinzas = [];
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const px = Math.floor(((x + 0.5) * im.width) / 8);
        const py = Math.floor(((y + 0.5) * im.height) / 8);
        const i = (py * im.width + px) * 4;
        cinzas.push((im.data[i] + im.data[i + 1] + im.data[i + 2]) / 3);
      }
    }
    const media = cinzas.reduce((a, b) => a + b, 0) / 64;
    bits = cinzas.map(v => (v > media ? 1 : 0)).join("");
  } catch {
    bits = null; // JPEG que o jpeg-js não decodifica — sem impressão digital
  }
  if (chave) cacheAhash.set(chave, bits);
  return bits;
}

/**
 * `a` e `b`: { buffer, mimetype, largura, altura, chave? }.
 * `chave` é opcional e só serve de índice do cache da impressão digital.
 */
function ehMesmaFoto(a, b) {
  if (!a || !b) return false;
  if (a.buffer && b.buffer && a.buffer.length === b.buffer.length && a.buffer.equals(b.buffer)) return true;
  if (!a.largura || !a.altura || !b.largura || !b.altura) return false;

  const proporcaoA = a.largura / a.altura;
  const proporcaoB = b.largura / b.altura;
  if (Math.abs(proporcaoA - proporcaoB) / Math.max(proporcaoA, proporcaoB) > TOLERANCIA_ASPECTO) return false;

  const ladoA = Math.max(a.largura, a.altura);
  const ladoB = Math.max(b.largura, b.altura);
  const maior = Math.max(ladoA, ladoB);
  const menor = Math.min(ladoA, ladoB);
  if (maior / menor < RAZAO_MINIATURA) return false;

  if (menor <= MINIATURA_MAX_DIM) return true;
  if (maior > AHASH_MAX_DIM) return false;
  if (a.mimetype !== "image/jpeg" || b.mimetype !== "image/jpeg") return false;

  const hashA = _ahash(a);
  const hashB = _ahash(b);
  if (!hashA || !hashB) return false;
  let diferentes = 0;
  for (let i = 0; i < 64; i += 1) if (hashA[i] !== hashB[i]) diferentes += 1;
  return diferentes <= HAMMING_MAX;
}

/**
 * Percorre a lista NA ORDEM e devolve quais nomes de arquivo devem sumir por
 * serem repetição de uma foto que já está na lista. Entre duas iguais fica a
 * de maior resolução, na posição em que a primeira delas aparecia — assim o
 * card não só deixa de repetir como ainda troca a miniatura pela foto boa.
 */
function escolherSemRepetidas(fotos) {
  const esconder = new Set();
  const mantidas = [];
  for (const foto of fotos) {
    const i = mantidas.findIndex(m => ehMesmaFoto(m, foto));
    if (i === -1) {
      mantidas.push(foto);
      continue;
    }
    const areaMantida = (mantidas[i].largura || 0) * (mantidas[i].altura || 0);
    const areaNova = (foto.largura || 0) * (foto.altura || 0);
    if (areaNova > areaMantida) {
      esconder.add(mantidas[i].nome);
      mantidas[i] = foto;
    } else {
      esconder.add(foto.nome);
    }
  }
  return esconder;
}

function limparCacheAhash() {
  cacheAhash.clear();
}

module.exports = {
  ehMesmaFoto,
  escolherSemRepetidas,
  limparCacheAhash,
  TOLERANCIA_ASPECTO,
  RAZAO_MINIATURA,
  HAMMING_MAX,
  MINIATURA_MAX_DIM,
  AHASH_MAX_DIM,
};
