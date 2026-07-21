/**
 * catalogo-fotos.service.js — acesso às fotos de produto do catálogo X2
 * (src/config/catalogo-x2/fotos/*.zip).
 *
 * Por que os zips ficam zipados: a pasta catalogo-x2/ está dentro do
 * OneDrive, e extrair ~27.600 fotos de uma vez (um arquivo pequeno por foto)
 * trava/atrasa o sync (ver README da pasta e memória do projeto). Por isso
 * este serviço NUNCA extrai o zip inteiro pra disco — ele lê só o índice
 * (Central Directory, leve) de cada zip uma vez, e descompacta sob demanda
 * apenas a foto pedida, usando src/utils/zip-reader.js.
 */
const fs = require("fs");
const path = require("path");
const { listarEntradas, extrairArquivo } = require("../utils/zip-reader");

const FOTOS_DIR = path.join(__dirname, "../config/catalogo-x2/fotos");

const MIME_POR_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

// Map<codigoProduto, Array<{ zipPath, entrada }>> — construído uma vez, na
// primeira chamada (lazy), e mantido em memória (só o índice, não as fotos).
let indice = null;

function _garantirIndice() {
  if (indice) return indice;
  indice = new Map();

  let arquivos = [];
  try {
    arquivos = fs.readdirSync(FOTOS_DIR).filter(f => f.endsWith(".zip"));
  } catch (e) {
    console.error("[catalogo-fotos.service] pasta de fotos não encontrada:", e.message);
    return indice;
  }

  for (const arquivo of arquivos) {
    const zipPath = path.join(FOTOS_DIR, arquivo);
    let entradas;
    try {
      entradas = listarEntradas(zipPath);
    } catch (e) {
      console.error(`[catalogo-fotos.service] falha ao ler índice de ${arquivo}:`, e.message);
      continue;
    }
    for (const entrada of entradas) {
      const barra = entrada.name.indexOf("/");
      if (barra <= 0) continue;
      const codigo = entrada.name.slice(0, barra);
      if (!indice.has(codigo)) indice.set(codigo, []);
      indice.get(codigo).push({ zipPath, entrada });
    }
  }

  console.log(`[catalogo-fotos.service] índice de fotos pronto: ${indice.size} produtos com foto.`);
  return indice;
}

/**
 * Lista as fotos disponíveis de um produto (sem carregar os bytes).
 * Retorna [{ indice: 0, nomeArquivo: "9839.jpg" }, ...].
 */
function listarFotos(codigoProduto) {
  const idx = _garantirIndice();
  const lista = idx.get(String(codigoProduto)) || [];
  return lista.map((item, i) => ({ indice: i, nomeArquivo: path.basename(item.entrada.name) }));
}

/**
 * Extrai uma foto específica de um produto. Retorna { buffer, mimetype }
 * ou null se o produto/índice de foto não existir.
 */
function obterFoto(codigoProduto, indiceFoto = 0) {
  const idx = _garantirIndice();
  const lista = idx.get(String(codigoProduto));
  if (!lista || !lista[indiceFoto]) return null;

  const { zipPath, entrada } = lista[indiceFoto];
  let buffer;
  try {
    buffer = extrairArquivo(zipPath, entrada);
  } catch (e) {
    console.error(`[catalogo-fotos.service] falha ao extrair foto (codigo=${codigoProduto}):`, e.message);
    return null;
  }
  const ext = path.extname(entrada.name).slice(1).toLowerCase();
  const mimetype = MIME_POR_EXT[ext] || "application/octet-stream";
  return { buffer, mimetype };
}

module.exports = { listarFotos, obterFoto };
