/**
 * zip-reader.js — leitor mínimo de .zip (só o necessário pra ler os zips de
 * fotos do catálogo X2, sem depender de lib externa — o projeto não tem
 * nenhuma lib de zip instalada, e adicionar uma exigiria `npm install`, que
 * hoje falha neste ambiente por causa da pasta node_modules estar dentro do
 * OneDrive, ver memória "OneDrive file sync corruption").
 *
 * Só lê o Central Directory (índice do zip, pequeno — algumas dezenas de KB
 * mesmo com milhares de entradas) pra listar os arquivos, e só descompacta
 * sob demanda o arquivo específico pedido. Nunca extrai o zip inteiro pra
 * disco — é assim que evitamos o problema de "milhares de arquivos pequenos
 * de uma vez" que trava o sync do OneDrive.
 *
 * Suporta os dois métodos de compressão que podem aparecer: STORE (0, sem
 * compressão — o método usado pelo script que gerou esses zips) e DEFLATE
 * (8, via zlib, caso algum zip futuro venha compactado de verdade).
 */
const fs = require("fs");
const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function _localizarEOCD(buf) {
  const maxBack = Math.min(buf.length, 65535 + 22);
  const start = buf.length - maxBack;
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("EOCD não encontrado — arquivo não parece ser um .zip válido");
}

/**
 * Lê só o índice (Central Directory) do zip. Retorna um array de
 * { name, method, compSize, uncompSize, localOffset }.
 */
function listarEntradas(zipPath) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const tailSize = Math.min(stat.size, 65535 + 22);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
    const eocdOffsetInTail = _localizarEOCD(tail);

    const totalEntries = tail.readUInt16LE(eocdOffsetInTail + 10);
    const cdSize        = tail.readUInt32LE(eocdOffsetInTail + 12);
    const cdOffset       = tail.readUInt32LE(eocdOffsetInTail + 16);

    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    const entradas = [];
    let p = 0;
    for (let i = 0; i < totalEntries; i++) {
      if (p + 46 > cdBuf.length || cdBuf.readUInt32LE(p) !== CENTRAL_SIG) break;
      const method      = cdBuf.readUInt16LE(p + 10);
      const compSize     = cdBuf.readUInt32LE(p + 20);
      const uncompSize   = cdBuf.readUInt32LE(p + 24);
      const nameLen      = cdBuf.readUInt16LE(p + 28);
      const extraLen     = cdBuf.readUInt16LE(p + 30);
      const commentLen   = cdBuf.readUInt16LE(p + 32);
      const localOffset  = cdBuf.readUInt32LE(p + 42);
      const name = cdBuf.toString("utf8", p + 46, p + 46 + nameLen);
      entradas.push({ name, method, compSize, uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entradas;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Descompacta uma entrada específica (obtida via listarEntradas) e retorna
 * o buffer com o conteúdo real do arquivo.
 */
function extrairArquivo(zipPath, entrada) {
  const fd = fs.openSync(zipPath, "r");
  try {
    const localHeader = Buffer.alloc(30);
    fs.readSync(fd, localHeader, 0, 30, entrada.localOffset);
    if (localHeader.readUInt32LE(0) !== LOCAL_SIG) {
      throw new Error("cabeçalho local inválido no offset informado");
    }
    const nameLen  = localHeader.readUInt16LE(26);
    const extraLen = localHeader.readUInt16LE(28);
    const dataOffset = entrada.localOffset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entrada.compSize);
    fs.readSync(fd, raw, 0, entrada.compSize, dataOffset);

    if (entrada.method === 0) return raw;
    if (entrada.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`método de compressão não suportado: ${entrada.method}`);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { listarEntradas, extrairArquivo };
