/**
 * Testes de src/whatsapp/contacts.js — autoRegisterContact().
 *
 * Foco no fix do gap lid/jid (ver nota no arquivo): quando um cliente
 * chega primeiro via "@lid" sem resolução (LID_FALLBACK em
 * src/config/whatsapp.js), o número salvo é o identificador NUMÉRICO do
 * próprio lid, não o telefone real. Se esse cliente resolve depois (nova
 * mensagem já chega como "@s.whatsapp.net"), sem o fix isso criava um
 * SEGUNDO registro de contato pro mesmo cliente em vez de migrar o antigo.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));

const pool = require("../src/database/postgres");
const { emitEvent } = require("../src/services/socket.service");
const { autoRegisterContact } = require("../src/whatsapp/contacts");
const { setLidMapping } = require("../src/whatsapp/lid-map");

function buildState() {
  return { contacts: [] };
}

function installFakePool(state) {
  let idCounter = 0;
  pool.query.mockImplementation(async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/^SELECT id, nome FROM contacts WHERE whatsapp = \$1/.test(sql)) {
      const c = state.contacts.find(c => c.whatsapp === params[0]);
      return { rows: c ? [{ id: c.id, nome: c.nome }] : [] };
    }

    if (/^UPDATE contacts SET whatsapp = \$1/.test(sql)) {
      const c = state.contacts.find(c => c.id === params[2]);
      if (c) { c.whatsapp = params[0]; c.nome = params[1]; }
      return { rows: [] };
    }

    if (/^UPDATE contacts SET nome = \$1/.test(sql)) {
      const c = state.contacts.find(c => c.id === params[1]);
      if (c) c.nome = params[0];
      return { rows: [] };
    }

    if (/^INSERT INTO contacts/.test(sql)) {
      idCounter += 1;
      const c = { id: `c${idCounter}`, nome: params[0], whatsapp: params[1] };
      state.contacts.push(c);
      return { rows: [{ id: c.id }] };
    }

    throw new Error("Query não mapeada no mock de contacts.test.js: " + sql);
  });
}

describe("autoRegisterContact — equivalência lid/jid", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
  });

  test("cliente chega primeiro via @lid sem resolução, depois resolve para jid → migra o contato em vez de duplicar", async () => {
    const lid = "800900100200300@lid";
    const lidPhoneProvisorio = "800900100200300"; // dígitos do próprio lid (sem resolução)
    const jid = "5511966667777@s.whatsapp.net";
    const realPhone = "5511966667777";

    // 1ª mensagem: chega via @lid, sem resolução ainda — cria contato
    // provisório com o número do próprio lid.
    const id1 = await autoRegisterContact(lid, "Cliente Novo");
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0].whatsapp).toBe(lidPhoneProvisorio);

    // Agora o mapa lid→jid é aprendido (ex: mensagem seguinte trouxe senderPn,
    // ou sincronização de contatos).
    setLidMapping(lid, jid, "test");

    // 2ª mensagem do MESMO cliente, já resolvida para o jid real.
    const id2 = await autoRegisterContact(jid, "Cliente Novo");

    // Não deve ter criado um segundo contato — deve ter migrado o existente.
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0].whatsapp).toBe(realPhone);
    expect(id2).toBe(id1);
    expect(emitEvent).toHaveBeenCalledWith(
      "contacts_updated",
      expect.objectContaining({ reason: "auto_contact_merge", whatsapp: realPhone })
    );
  });

  test("sem mapeamento lid/jid conhecido, continua funcionando normalmente (comportamento antigo preservado)", async () => {
    const jid = "5511977778888@s.whatsapp.net";

    const id1 = await autoRegisterContact(jid, "Fulano");
    expect(state.contacts).toHaveLength(1);

    const id2 = await autoRegisterContact(jid, "Fulano");
    expect(state.contacts).toHaveLength(1);
    expect(id2).toBe(id1);
  });

  // Pedido do usuário (2026-07-24): todo contato novo nasce "Leads"
  // (renomeado de "Clientes Novos" em 2026-07-31) — vira "Clientes" só
  // quando gera um ticket (ver marcarComoCliente, src/services/contacts
  // .service.js, testado em contacts.service.marcar-cliente.test.js).
  test("contato novo é criado com a tag 'Leads' por padrão", async () => {
    await autoRegisterContact("5511988887777@s.whatsapp.net", "Novo Cliente");

    const insertCall = pool.query.mock.calls.find(([sql]) => /^INSERT INTO contacts/.test(sql));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain("'Leads'");
  });
});
