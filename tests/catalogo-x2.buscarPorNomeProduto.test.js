/**
 * Testes de buscarPorNomeProduto (catalogo-x2.service.js) contra o catálogo
 * REAL (o serviço não aceita injeção de dados — indexa direto de
 * config/catalogo-x2/*.json no require, mesmo padrão já usado em
 * catalogo-x2.alias-e-universal.test.js).
 *
 * Dois bugs reais já encontrados nesta função ao testar ao vivo com o
 * usuário (2026-08-14), ambos da MESMA família — mensagem sem nome de peça
 * nenhum batendo em produto errado só porque um token genérico (não
 * relacionado a peça nenhuma) coincidia com a lista de aplicação embutida
 * no NOME do produto:
 *
 *  1. "preciso de uma peça pro meu fiat palio 2025" → bateu numa PALHETA só
 *     por FIAT+PALIO (veículo que o cliente já tinha citado). Fix:
 *     PALAVRAS_GENERICAS_PECA ("peça" não conta como token) + parâmetro
 *     veiculoTexto (desconta as palavras do veículo já extraído).
 *  2. "Vocês trabalham com linha pesada, tipo caminhão Volvo?" → bateu numa
 *     PALHETA (limpador de para-brisa) só por CAMINHAO+VOLVO/LINHA. Fix:
 *     "caminhao"/"moto"/"onibus" viraram stopword de veículo genérico
 *     (mesma categoria de "carro"/"veiculo", que já eram) e "linha"/
 *     "pesada"/"leve"/"agricola" (vocabulário de SEGMENTO da loja, não nome
 *     de peça) entraram em PALAVRAS_GENERICAS_PECA.
 */
const { buscarPorNomeProduto } = require("../src/services/catalogo-x2.service");

describe("catalogo-x2.service — buscarPorNomeProduto", () => {
  describe("bug real: pergunta genérica sobre segmento/linha não deve confirmar produto nenhum", () => {
    test.each([
      "Vocês trabalham com linha pesada, tipo caminhão Volvo?",
      "Vocês trabalham com linha pesada, tipo caminhão Scania?",
      "trabalham com linha leve?",
      "vocês atendem linha agrícola?",
    ])("'%s' → nenhum match", (msg) => {
      expect(buscarPorNomeProduto(msg, { limite: 3 })).toEqual([]);
    });
  });

  describe("bug real: tipo de veículo genérico (sem marca/modelo) não deve contar como token", () => {
    test.each([
      "trabalham com moto?",
      "tem peça pra ônibus?",
      "vocês atendem caminhão?",
    ])("'%s' → nenhum match", (msg) => {
      expect(buscarPorNomeProduto(msg, { limite: 3 })).toEqual([]);
    });
  });

  describe("bug real (fix anterior, 2026-08-14): peça genérica + veículo já citado", () => {
    // veiculoTexto simula o que ai.service.js sempre passa nesse call site
    // (o veículo já extraído pela IA) — sem esse parâmetro, FIAT/PALIO
    // sozinhos ainda contam como 2 tokens válidos (esperado: "peça" some,
    // mas o veículo em si só é descontado quando o chamador informa
    // veiculoTexto, que é o que ai.service.js sempre faz nesse ponto).
    test.each([
      ["preciso de uma peça pro meu fiat palio 2025", "Fiat Palio 2025"],
      ["Bom dia, preciso de uma peça pro meu fiat 2025", "Fiat 2025"],
    ])("'%s' (veiculoTexto=%s) → nenhum match", (msg, veiculoTexto) => {
      expect(buscarPorNomeProduto(msg, { limite: 3, veiculoTexto })).toEqual([]);
    });
  });

  describe("casos legítimos continuam funcionando (não pode virar falso negativo)", () => {
    test("nome de peça claro, sem veículo → acha produto real", () => {
      const r = buscarPorNomeProduto("correia dentada pra corsa", { limite: 1 });
      expect(r.length).toBeGreaterThan(0);
      expect(r[0].nome.toUpperCase()).toContain("CORREIA DENTADA");
    });

    test("peça + marca de fabricante (não veículo) → acha produto real", () => {
      const r = buscarPorNomeProduto("rotor de alternador bosch", { limite: 1 });
      expect(r.length).toBeGreaterThan(0);
      expect(r[0].nome.toUpperCase()).toContain("ROTOR");
    });

    test("linha pesada + peça específica (não só a marca/tipo genérico) ainda pode confirmar, já que há nome de peça real", () => {
      const r = buscarPorNomeProduto("palheta pra caminhão volvo", { limite: 1 });
      expect(r.length).toBeGreaterThan(0);
      expect(r[0].nome.toUpperCase()).toContain("PALHETA");
    });
  });
});
