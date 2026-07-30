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

  // BUG CORRIGIDO (achado em sessão de testes ao vivo, 2026-07-29): 2º
  // pedido do dia sem veículo informado (cliente digitou "pular") mostrava
  // o veículo de um pedido ANTERIOR do mesmo ticket, porque o regex de
  // veículo rodava sobre a description inteira (todos os pedidos
  // acumulados via prependDescription) em vez de só o pedido atual —
  // ver comentário em ORCAMENTO_SOLICITADO.
  it("NÃO mostra o veículo de um pedido anterior quando o pedido atual não informou veículo", () => {
    const ticket = {
      customerName: "Design / Marketing",
      protocolo: "2026-0223",
      description:
        "Produto: correia dentada\n" +
        "---\n" +
        "(pedido anterior) Veículo: Hilux 2015 | Produto: Farol de milha",
    };

    const texto = MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
    expect(texto).not.toContain("🚗");
    expect(texto).not.toContain("Hilux 2015");
    expect(texto).toContain("correia dentada");
  });

  it("mostra o veículo certo do pedido atual mesmo com pedidos anteriores de outro veículo", () => {
    const ticket = {
      customerName: "Design / Marketing",
      protocolo: "2026-0223",
      description:
        "Veículo: Honda Civic 2019 | Produto: Alternador\n" +
        "---\n" +
        "(pedido anterior) Veículo: GM Corsa 2010 | Produto: jogo de palhetas",
    };

    const texto = MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
    expect(texto).toContain("🚗 Honda Civic 2019");
    expect(texto).not.toContain("GM Corsa 2010");
    expect(texto).toContain("Alternador");
  });
});
