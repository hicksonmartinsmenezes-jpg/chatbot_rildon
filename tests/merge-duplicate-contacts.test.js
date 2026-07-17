/**
 * Testes de scripts/merge-duplicate-contacts.js — foco nas funções puras
 * de decisão de fusão (decidirFusao/pareceNomeGenerico), usadas pelo
 * script de limpeza retroativa do task #140 (contatos duplicados: mesmo
 * cliente com uma linha sob o número provisório do @lid e outra já com o
 * telefone real, ver src/whatsapp/contacts.js e src/whatsapp/lid-map.js).
 *
 * O script em si (main(), acesso a banco) não é testado aqui — só a lógica
 * de decisão, que é o que determina se a fusão preserva os dados certos.
 */
const { apenasDigitos, pareceNomeGenerico, decidirFusao } = require("../scripts/merge-duplicate-contacts");

describe("merge-duplicate-contacts — apenasDigitos", () => {
  test("remove tudo que não é dígito", () => {
    expect(apenasDigitos("5511988889999@s.whatsapp.net")).toBe("5511988889999");
    expect(apenasDigitos("(11) 98888-9999")).toBe("11988889999");
  });

  test("vazio/nulo → string vazia", () => {
    expect(apenasDigitos("")).toBe("");
    expect(apenasDigitos(null)).toBe("");
  });
});

describe("merge-duplicate-contacts — pareceNomeGenerico", () => {
  test("nome vazio é genérico", () => {
    expect(pareceNomeGenerico("", "5511988889999")).toBe(true);
  });

  test("nome igual ao próprio telefone é genérico", () => {
    expect(pareceNomeGenerico("5511988889999", "5511988889999")).toBe(true);
  });

  test("nome só com dígitos (8-15) é genérico, mesmo não batendo com o telefone salvo", () => {
    expect(pareceNomeGenerico("988889999", "5511988889999")).toBe(true);
  });

  test("nome real não é genérico", () => {
    expect(pareceNomeGenerico("Hickson Martins", "5511988889999")).toBe(false);
  });
});

describe("merge-duplicate-contacts — decidirFusao", () => {
  function contato(overrides = {}) {
    return { nome: "", whatsapp: "", status: "ativo", tags: [], atendente_id: null, ...overrides };
  }

  test("prefere o nome REAL do antigo quando o canônico só tem o telefone como nome", () => {
    const antigo = contato({ nome: "Hickson Martins", whatsapp: "600700800900100" });
    const canonico = contato({ nome: "5511988889999", whatsapp: "5511988889999" });

    const fusao = decidirFusao(antigo, canonico);
    expect(fusao.nome).toBe("Hickson Martins");
  });

  test("mantém o nome do canônico quando ele já é um nome real", () => {
    const antigo = contato({ nome: "600700800900100", whatsapp: "600700800900100" });
    const canonico = contato({ nome: "Hickson Martins", whatsapp: "5511988889999" });

    const fusao = decidirFusao(antigo, canonico);
    expect(fusao.nome).toBe("Hickson Martins");
  });

  test("une as tags dos dois registros, sem duplicar", () => {
    const antigo = contato({ tags: ["Funcionário(a)", "VIP"] });
    const canonico = contato({ tags: ["VIP", "Diretor Geral"] });

    const fusao = decidirFusao(antigo, canonico);
    expect(fusao.tags.sort()).toEqual(["Diretor Geral", "Funcionário(a)", "VIP"].sort());
  });

  test("mantém atendente_id do canônico se já tiver um definido", () => {
    const antigo = contato({ atendente_id: "at-1" });
    const canonico = contato({ atendente_id: "at-2" });

    expect(decidirFusao(antigo, canonico).atendenteId).toBe("at-2");
  });

  test("usa atendente_id do antigo só se o canônico não tiver nenhum", () => {
    const antigo = contato({ atendente_id: "at-1" });
    const canonico = contato({ atendente_id: null });

    expect(decidirFusao(antigo, canonico).atendenteId).toBe("at-1");
  });

  test("status 'ativo' vence se qualquer um dos dois estava ativo", () => {
    const antigo = contato({ status: "ativo" });
    const canonico = contato({ status: "inativo" });

    expect(decidirFusao(antigo, canonico).status).toBe("ativo");
  });

  test("mantém o status do canônico quando nenhum dos dois está ativo", () => {
    const antigo = contato({ status: "inativo" });
    const canonico = contato({ status: "arquivado" });

    expect(decidirFusao(antigo, canonico).status).toBe("arquivado");
  });
});
