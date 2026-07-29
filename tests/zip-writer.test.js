/**
 * Testes de zip-writer.js — companheiro do zip-reader.js já existente.
 *
 * PEDIDO DO USUÁRIO (2026-07-27): "é possível criar uma ferramenta que faça
 * exatamente isso que está fazendo?" (a rotina de baixar fotos do X2 de
 * forma automatizada, sem mim conduzindo passo a passo pelo chat). O novo
 * script `scripts/x2-fotos-scraper.js` baixa as fotos direto em disco e, ao
 * final de uma seção, monta o .zip final — precisa de um escritor de zip
 * puro-JS (sem depender do binário `zip` do sistema, que nem existe por
 * padrão no Windows) e compatível com o leitor que o servidor já usa
 * (`src/services/catalogo-fotos.service.js` via `zip-reader.js`).
 *
 * Validação real: o zip gerado também foi conferido manualmente com o
 * `unzip` do sistema (fora deste teste) — os testes abaixo garantem que o
 * MESMO leitor que o servidor usa em produção consegue ler de volta
 * exatamente os bytes originais.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { criarZip, crc32 } = require("../src/utils/zip-writer");
const { listarEntradas, extrairArquivo } = require("../src/utils/zip-reader");

function escreverEler(entradas) {
  const zipPath = path.join(os.tmpdir(), `zip-writer-test-${Date.now()}-${Math.random()}.zip`);
  fs.writeFileSync(zipPath, criarZip(entradas));
  try {
    return listarEntradas(zipPath).map((meta, i) => ({
      meta,
      conteudo: extrairArquivo(zipPath, meta),
    }));
  } finally {
    fs.unlinkSync(zipPath);
  }
}

describe("zip-writer.criarZip — round-trip com zip-reader.js (o leitor real usado em produção)", () => {
  test("uma entrada simples: nome e conteúdo batem byte-a-byte", () => {
    const data = Buffer.from("conteudo de teste da foto");
    const lidas = escreverEler([{ name: "123456/0.jpg", data }]);

    expect(lidas).toHaveLength(1);
    expect(lidas[0].meta.name).toBe("123456/0.jpg");
    expect(lidas[0].meta.method).toBe(0); // STORE
    expect(Buffer.compare(lidas[0].conteudo, data)).toBe(0);
  });

  test("múltiplas entradas, múltiplos códigos de produto, ordem preservada", () => {
    const entradas = [
      { name: "111111/0.jpg", data: Buffer.from("foto A") },
      { name: "111111/1.png", data: Buffer.from("foto B, mesmo produto") },
      { name: "222222/0.webp", data: Buffer.from("foto de outro produto") },
    ];
    const lidas = escreverEler(entradas);

    expect(lidas.map(l => l.meta.name)).toEqual(["111111/0.jpg", "111111/1.png", "222222/0.webp"]);
    lidas.forEach((l, i) => {
      expect(Buffer.compare(l.conteudo, entradas[i].data)).toBe(0);
    });
  });

  test("arquivo grande (maior que um bloco típico) preserva conteúdo e tamanho", () => {
    const grande = Buffer.alloc(500_000);
    for (let i = 0; i < grande.length; i++) grande[i] = i % 256;
    const lidas = escreverEler([{ name: "999999/0.jpg", data: grande }]);

    expect(lidas[0].meta.uncompSize).toBe(500_000);
    expect(Buffer.compare(lidas[0].conteudo, grande)).toBe(0);
  });

  test("zip vazio (nenhuma entrada) não quebra o leitor — 0 entradas", () => {
    const lidas = escreverEler([]);
    expect(lidas).toHaveLength(0);
  });

  test("nomes com acentos/caracteres especiais (comuns em nomes de produto) sobrevivem ao round-trip", () => {
    const data = Buffer.from("foto");
    const lidas = escreverEler([{ name: "103675/0_caixa-fusível-é-ç.jpg", data }]);
    expect(lidas[0].meta.name).toBe("103675/0_caixa-fusível-é-ç.jpg");
  });

  test("crc32() é determinístico e sensível a qualquer mudança de conteúdo", () => {
    const a = crc32(Buffer.from("abc"));
    const b = crc32(Buffer.from("abc"));
    const c = crc32(Buffer.from("abd"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
