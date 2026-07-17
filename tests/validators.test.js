/**
 * Testes de src/utils/validators.js.
 *
 * Achado no Raio-X geral (RAIO_X_GERAL_V16.md): este arquivo é a base de
 * validação compartilhada por vendas.flow.js e crediario.flow.js (nome,
 * CPF, tamanho de texto, sanitização/normalização usada nas checagens de
 * "mudança de assunto" e "dado pessoal" corrigidas nesta sessão) — um bug
 * silencioso aqui afeta os dois fluxos ao mesmo tempo. Tinha 31% de
 * cobertura antes deste arquivo.
 */
const {
  sanitizarTexto,
  normalizar,
  validarTamanho,
  mensagemTamanhoInvalido,
  validarCPF,
  formatarCPF,
  validarCNPJ,
  formatarCNPJ,
  validarNome,
} = require("../src/utils/validators");

describe("validators — sanitizarTexto", () => {
  test("remove caracteres de controle", () => {
    expect(sanitizarTexto("ol\x00\x1Fá")).toBe("olá");
  });

  test("remove espaços nas pontas (trim)", () => {
    expect(sanitizarTexto("  oi  ")).toBe("oi");
  });

  test("corta no limite de tamanho (padrão MAX_CHARS_INPUT)", () => {
    const texto = "a".repeat(600);
    expect(sanitizarTexto(texto).length).toBe(500);
  });

  test("respeita limite customizado", () => {
    expect(sanitizarTexto("abcdefghij", 5)).toBe("abcde");
  });

  test("entrada não-string → string vazia (não quebra)", () => {
    expect(sanitizarTexto(null)).toBe("");
    expect(sanitizarTexto(undefined)).toBe("");
    expect(sanitizarTexto(123)).toBe("");
  });
});

describe("validators — normalizar", () => {
  test("trim + lowercase", () => {
    expect(normalizar("  OI TUDO BEM  ")).toBe("oi tudo bem");
  });

  test("remove acentos", () => {
    expect(normalizar("Não é possível, coração")).toBe("nao e possivel, coracao");
  });

  test("entrada vazia/nula/indefinida → string vazia", () => {
    expect(normalizar("")).toBe("");
    expect(normalizar(null)).toBe("");
    expect(normalizar(undefined)).toBe("");
  });

  // Base de todo _pareceMudancaDeAssunto/_pareceCPFOuDadoPessoal
  // (vendas.flow.js/crediario.flow.js) — precisa normalizar "Crediário?"
  // pra "crediario?" pra bater com os regexes ali.
  test("caso real usado na detecção de mudança de assunto", () => {
    expect(normalizar("Vocês fazem CREDIÁRIO?")).toBe("voces fazem crediario?");
  });
});

describe("validators — validarTamanho", () => {
  test("texto dentro do intervalo → ok", () => {
    expect(validarTamanho("motor de partida", 5)).toEqual({ ok: true });
  });

  test("texto menor que o mínimo → erro 'minimo'", () => {
    expect(validarTamanho("oi", 5)).toEqual({ ok: false, erro: "minimo" });
  });

  test("texto maior que o máximo → erro 'maximo'", () => {
    expect(validarTamanho("a".repeat(20), 1, 10)).toEqual({ ok: false, erro: "maximo" });
  });

  test("limite exato (mínimo e máximo) conta como válido", () => {
    expect(validarTamanho("abcde", 5, 5)).toEqual({ ok: true });
  });
});

describe("validators — mensagemTamanhoInvalido", () => {
  test("menciona o limite configurado", () => {
    expect(mensagemTamanhoInvalido()).toContain("500");
    expect(mensagemTamanhoInvalido()).toContain("muito longa");
  });
});

describe("validators — validarCPF", () => {
  test("CPF válido (dígitos verificadores corretos)", () => {
    expect(validarCPF("111.444.777-35")).toBe(true);
    expect(validarCPF("529.982.247-25")).toBe(true);
  });

  test("CPF com todos os dígitos iguais → inválido (bloqueado explicitamente)", () => {
    expect(validarCPF("11111111111")).toBe(false);
    expect(validarCPF("00000000000")).toBe(false);
  });

  test("CPF com dígito verificador errado → inválido", () => {
    expect(validarCPF("123.456.789-00")).toBe(false);
  });

  test("quantidade errada de dígitos → inválido", () => {
    expect(validarCPF("123456789")).toBe(false);
    expect(validarCPF("123456789012")).toBe(false);
  });

  test("vazio/nulo → inválido, não quebra", () => {
    expect(validarCPF("")).toBe(false);
    expect(validarCPF(null)).toBe(false);
    expect(validarCPF(undefined)).toBe(false);
  });

  test("aceita com ou sem formatação (pontuação é ignorada)", () => {
    expect(validarCPF("11144477735")).toBe(validarCPF("111.444.777-35"));
  });
});

describe("validators — formatarCPF", () => {
  test("formata dígitos crus no padrão 000.000.000-00", () => {
    expect(formatarCPF("52998224725")).toBe("529.982.247-25");
  });
});

describe("validators — validarCNPJ", () => {
  test("CNPJ válido", () => {
    expect(validarCNPJ("11.222.333/0001-81")).toBe(true);
    expect(validarCNPJ("11.444.777/0001-61")).toBe(true);
  });

  test("todos os dígitos iguais → inválido", () => {
    expect(validarCNPJ("00000000000000")).toBe(false);
  });

  test("dígito verificador errado → inválido", () => {
    expect(validarCNPJ("11222333000199")).toBe(false);
  });

  test("quantidade errada de dígitos → inválido", () => {
    expect(validarCNPJ("112223330001")).toBe(false);
  });
});

describe("validators — formatarCNPJ", () => {
  test("formata dígitos crus no padrão 00.000.000/0000-00", () => {
    expect(formatarCNPJ("11222333000181")).toBe("11.222.333/0001-81");
  });
});

describe("validators — validarNome", () => {
  test("nome completo (2+ palavras) válido", () => {
    expect(validarNome("Hickson Martins")).toBe(true);
  });

  test("nome único com 3+ caracteres é aceito (apelido/artista)", () => {
    expect(validarNome("Rildon")).toBe(true);
    expect(validarNome("Cher")).toBe(true);
  });

  test("nome único com menos de 3 caracteres é rejeitado", () => {
    expect(validarNome("Al")).toBe(false);
    expect(validarNome("A")).toBe(false);
  });

  test("aceita hífen e apóstrofo dentro do nome (D'Angelo, Jean-Pierre)", () => {
    expect(validarNome("D'Angelo Souza")).toBe(true);
    expect(validarNome("Jean-Pierre")).toBe(true);
  });

  test("nome com números é rejeitado", () => {
    expect(validarNome("Cliente123")).toBe(false);
  });

  test("string vazia é rejeitada", () => {
    expect(validarNome("")).toBe(false);
    expect(validarNome("   ")).toBe(false);
  });

  test("só símbolos/pontuação é rejeitado", () => {
    expect(validarNome("!!!")).toBe(false);
    expect(validarNome("???")).toBe(false);
  });

  // Achado real ao escrever este teste (não assumido, verificado na
  // prática): validarNome() SOZINHA aceita uma frase com 2+ palavras
  // "formato-nome" (aqui: "meu", "pode", "confirmar", "meu" — todas só
  // letras) mesmo sendo claramente uma frase, não um nome — ela só rejeita
  // palavras com dígito/pontuação grudada, não a estrutura da frase como
  // um todo. É exatamente por isso que vendas.flow.js precisou de uma
  // checagem SEPARADA (_pareceCPFOuDadoPessoal) pra bloquear esse caso —
  // validarNome não é (e não foi projetada pra ser) suficiente sozinha
  // contra esse tipo de entrada.
  test("frase com CPF ainda passa como 'nome válido' aqui — por isso vendas.flow.js tem checagem própria de CPF", () => {
    expect(validarNome("meu cpf e 123.456.789-01, pode confirmar meu cadastro?")).toBe(true);
  });

  test("aceita nomes com acento", () => {
    expect(validarNome("José António")).toBe(true);
  });
});
