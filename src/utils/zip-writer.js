/**
 * zip-writer.js — escritor mínimo de .zip (método STORE, sem compressão),
 * companheiro do zip-reader.js já existente (que lê STORE e DEFLATE).
 *
 * Por quê STORE e não DEFLATE: as fotos já vêm comprimidas (JPEG/PNG/WEBP) —
 * tentar comprimir de novo com DEFLATE não economiza espaço relevante e só
 * gasta CPU. É o mesmo método já usado nos zips de fotos existentes do
 * catálogo X2 (ver README de src/config/catalogo-x2/, "zip -D").
 *
 * Sem dependência externa — mesmo princípio do zip-reader.js: o projeto não
 * tem lib de zip instalada, e node_modules dentro do OneDrive já causou
 * problema de sync (ver memória "OneDrive file sync corruption").
 *
 * Uso:
 *   const { criarZip } = require("./zip-writer");
 *   const buf = criarZip([{ name: "123456/0.jpg", data: bufferDaFoto }, ...]);
 *   fs.writeFileSync("saida.zip", buf);
 */
const zlib = require("zlib");

// ─── CRC32 (tabela padrão IEEE 802.3) ──────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time fixo (não importa pro uso — só leitura por código, nunca por
// data de modificação) — evita depender de Date/timezone.
const DOS_TIME = 0;
const DOS_DATE = (1 << 9) | (1 << 5) | 1; // 1980-01-01, campo mínimo válido

/**
 * Monta um .zip em memória (método STORE) a partir de uma lista de entradas
 * { name, data }. `name` deve usar "/" como separador (padrão zip), sem
 * barra inicial. Não cria entradas de diretório — mesmo padrão usado até
 * agora via `zip -D`.
 */
function criarZip(entradas) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { name, data } of entradas) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const size = data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);       // version needed
    localHeader.writeUInt16LE(0, 6);        // flags
    localHeader.writeUInt16LE(0, 8);        // method = STORE
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);    // compressed size
    localHeader.writeUInt32LE(size, 22);    // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);       // extra length

    localChunks.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);     // version made by
    centralHeader.writeUInt16LE(20, 6);     // version needed
    centralHeader.writeUInt16LE(0, 8);      // flags
    centralHeader.writeUInt16LE(0, 10);     // method = STORE
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);     // extra length
    centralHeader.writeUInt16LE(0, 32);     // comment length
    centralHeader.writeUInt16LE(0, 34);     // disk number start
    centralHeader.writeUInt16LE(0, 36);     // internal attrs
    centralHeader.writeUInt32LE(0, 38);     // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDirSize = centralChunks.reduce((s, b) => s + b.length, 0);
  const centralDirOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                       // disk number
  eocd.writeUInt16LE(0, 6);                       // disk with CD
  eocd.writeUInt16LE(entradas.length, 8);          // entries on this disk
  eocd.writeUInt16LE(entradas.length, 10);         // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);                      // comment length

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

module.exports = { criarZip, crc32 };
