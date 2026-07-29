/**
 * BUG CORRIGIDO (relatado pelo usuário — caso real "V. Hugo", protocolo
 * #2026-0083): cliente pediu orçamento de 4 itens em linhas separadas
 * (peça, conector, multímetro, conduíte). O ticket.description gravado no
 * banco sempre teve o texto completo (vendas.flow.js salva produtoTexto
 * inteiro) — o bug era só na mensagem de confirmação enviada ao cliente,
 * que usava /Produto:\s*(.+)/ (sem dotAll) e cortava tudo depois da
 * primeira quebra de linha, mostrando só o primeiro item.
 */
const MSG = require("../src/flows/messages");

describe("MSG.vendas.ORCAMENTO_SOLICITADO — orçamento com múltiplos itens", () => {
  it("preserva todos os itens (separados por quebra de linha) na mensagem de confirmação", () => {
    const ticket = {
      customerName: "V. Hugo~",
      protocolo: "2026-0083",
      description:
        "Produto: 8 Corujinhas do quebra sol do scania série 4;\n" +
        "8 conectores para essa corujinha;\n" +
        "1 multímetro;\n" +
        "10m de conduíte do fino",
    };

    const texto = MSG.vendas.ORCAMENTO_SOLICITADO(ticket);

    expect(texto).toContain("8 Corujinhas do quebra sol do scania série 4");
    expect(texto).toContain("8 conectores para essa corujinha");
    expect(texto).toContain("1 multímetro");
    expect(texto).toContain("10m de conduíte do fino");
  });

  it("continua extraindo o veículo separadamente quando presente, sem misturar com a peça", () => {
    const ticket = {
      customerName: "Cliente Teste",
      protocolo: "2026-0099",
      description: "Veículo: Gol 2015 | Produto: alternador\nregulador de voltagem",
    };

    const texto = MSG.vendas.ORCAMENTO_SOLICITADO(ticket);

    expect(texto).toContain("🚗 Gol 2015");
    expect(texto).toContain("alternador");
    expect(texto).toContain("regulador de voltagem");
  });

  it("caso de item único continua funcionando normalmente (sem regressão)", () => {
    const ticket = {
      customerName: "Cliente Único",
      protocolo: "2026-0100",
      description: "Produto: pastilha de freio dianteira",
    };

    const texto = MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
    expect(texto).toContain("pastilha de freio dianteira");
  });
});
