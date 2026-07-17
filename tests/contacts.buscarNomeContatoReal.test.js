/**
 * Testes de src/whatsapp/contacts.js — buscarNomeContatoReal().
 *
 * Fonte única de "nome real do contato" (perfil do WhatsApp, tabela
 * contacts) usada por main.flow.js (saudação), ticket.controller.js
 * (saudação de atendente + pesquisa de satisfação) e message.controller.js
 * (envio manual do painel) — antes cada um resolvia o nome à sua
 * maneira, causando bugs de contaminação: um nome digitado num orçamento
 * antigo (tickets.customer_name) ou até um contact_name já contaminado no
 * histórico "vazavam" pra saudações e mensagens seguintes.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const { buscarNomeContatoReal } = require("../src/whatsapp/contacts");
const { setLidMapping } = require("../src/whatsapp/lid-map");

function mockContactRow(nome) {
  pool.query.mockImplementation((sql) => {
    if (String(sql).includes("FROM contacts")) {
      return Promise.resolve({ rows: nome ? [{ nome }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe("buscarNomeContatoReal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("retorna o nome quando a tabela contacts tem um registro válido", async () => {
    mockContactRow("Design / Marketing");

    const nome = await buscarNomeContatoReal("5511999999999@s.whatsapp.net");

    expect(nome).toBe("Design / Marketing");
  });

  test("nome só com dígitos (placeholder de telefone) é ignorado, retorna null", async () => {
    mockContactRow("5511999999999");

    const nome = await buscarNomeContatoReal("5511999999999@s.whatsapp.net");

    expect(nome).toBeNull();
  });

  test("sem registro em contacts → retorna null", async () => {
    mockContactRow(null);

    const nome = await buscarNomeContatoReal("5511999999999@s.whatsapp.net");

    expect(nome).toBeNull();
  });

  test("erro no banco → não lança, retorna null (best-effort)", async () => {
    pool.query.mockRejectedValue(new Error("DB indisponível"));

    const nome = await buscarNomeContatoReal("5511999999999@s.whatsapp.net");

    expect(nome).toBeNull();
  });

  // Mesma classe de bug já corrigida em outros pontos do sistema: a
  // mensagem pode chegar num formato (@lid) diferente do que o contato
  // foi originalmente registrado (@s.whatsapp.net) — getProfilePhotoCandidates
  // garante que o telefone certo seja usado na busca mesmo assim.
  test("resolve o telefone certo mesmo quando a mensagem chega em formato @lid mapeado", async () => {
    const lid = "999888777666555@lid";
    const jid = "5511999999999@s.whatsapp.net";
    setLidMapping(lid, jid, "test");
    mockContactRow("Design / Marketing");

    const nome = await buscarNomeContatoReal(lid);

    expect(nome).toBe("Design / Marketing");
    const chamadaContacts = pool.query.mock.calls.find(([sql]) => String(sql).includes("FROM contacts"));
    expect(chamadaContacts[1][0]).toEqual(expect.arrayContaining(["5511999999999"]));
  });
});
