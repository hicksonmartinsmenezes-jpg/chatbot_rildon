const {
  LIMITE_CODIGOS,
  parseListaCodigos,
  classificarCodigos,
  montarMapaCodigos,
} = require("../scripts/x2-painel/fotos-codigos");

describe("parseListaCodigos", () => {
  test("aceita linhas, virgulas, ponto e virgula e espacos; tira vazios e repetidos", () => {
    expect(parseListaCodigos("1001\n1002, 1003;1004\t1001\n\n  1005  ")).toEqual(["1001", "1002", "1003", "1004", "1005"]);
  });
  test("aceita array e remove aspas", () => {
    expect(parseListaCodigos(['"1001"', "'1002'"])).toEqual(["1001", "1002"]);
  });
  test("entrada vazia ou nula -> lista vazia", () => {
    expect(parseListaCodigos("")).toEqual([]);
    expect(parseListaCodigos(null)).toEqual([]);
  });
  test("exporta o limite", () => {
    expect(LIMITE_CODIGOS).toBeGreaterThan(0);
  });
});

describe("classificarCodigos / montarMapaCodigos", () => {
  const mapa = montarMapaCodigos({
    eletrica: [{ codigo: "1001" }, { codigo: 1002 }],
    motor: [{ codigo: "1002" }, { codigo: "2001" }],
  });

  test("monta o mapa com codigo em mais de uma secao", () => {
    expect(mapa.get("1002")).toEqual(["eletrica", "motor"]);
  });
  test("separa conhecidos e novos e junta as secoes sem repetir", () => {
    const r = classificarCodigos(["1001", "2001", "9999"], mapa);
    expect(r.conhecidos).toEqual(["1001", "2001"]);
    expect(r.novos).toEqual(["9999"]);
    expect(r.slugs.sort()).toEqual(["eletrica", "motor"]);
  });
});
