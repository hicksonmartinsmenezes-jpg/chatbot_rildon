const XLSX = require("@e965/xlsx");
const { _parseXlsxPrecos } = require("../src/controllers/catalogo.controller");

function xlsBuffer(linhas) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), "P");
  return XLSX.write(wb, { type: "buffer", bookType: "biff8" });
}

describe("upload de preços .xls (binário antigo)", () => {
  test("lê código e preço de um .xls de verdade", async () => {
    const buf = xlsBuffer([["codigo", "preco"], [111430, 99.9], ["A12", "10,5"], ["", 5]]);
    expect(buf.readUInt32BE(0)).toBe(0xD0CF11E0);
    const mapa = await _parseXlsxPrecos(buf);
    expect(mapa.get("111430")).toBe(99.9);
    expect(mapa.get("A12")).toBe(10.5);
    expect(mapa.size).toBe(2);
  });

  test("cabeçalho sem preço dá erro claro", async () => {
    const buf = xlsBuffer([["codigo", "nome"], [1, "x"]]);
    await expect(_parseXlsxPrecos(buf)).rejects.toThrow(/coluna de código/);
  });
});
