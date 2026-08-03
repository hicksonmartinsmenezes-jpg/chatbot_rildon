/**
 * Testes de marcarComoCliente() (src/services/contacts.service.js).
 *
 * Feature pedida pelo usuário (2026-07-24): "só cadastre Clientes quando
 * gerarem tickets. Clientes Novos os que não chegarem a criar tickets."
 * Todo contato nasce com a tag "Leads" (ver autoRegisterContact,
 * src/whatsapp/contacts.js) — quando gera um ticket (createTicket,
 * ticket.service.js chama marcarComoCliente), a tag vira "Clientes".
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));

const pool = require("../src/database/postgres");
const { emitEvent } = require("../src/services/socket.service");
const { marcarComoCliente } = require("../src/services/contacts.service");

describe("marcarComoCliente", () => {
  beforeEach(() => jest.clearAllMocks());

  test("contato com 'Leads' → vira 'Clientes' (tag antiga sai, nova entra)", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "c1", tags: ["Leads"] }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    await marcarComoCliente("5511999998888@s.whatsapp.net");

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("UPDATE contacts SET tags"),
      [["Clientes"], "c1"]
    );
    expect(emitEvent).toHaveBeenCalledWith(
      "contacts_updated",
      expect.objectContaining({ reason: "ticket_gerado", whatsapp: "5511999998888" })
    );
  });

  test("preserva outras tags manuais já existentes (ex: Fabricante) ao promover", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "c2", tags: ["Leads", "Fabricante"] }] })
      .mockResolvedValueOnce({ rows: [] });

    await marcarComoCliente("5511977776666@s.whatsapp.net");

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      [["Fabricante", "Clientes"], "c2"]
    );
  });

  test("já é 'Clientes' → idempotente, não faz UPDATE de novo", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "c3", tags: ["Clientes"] }] });

    await marcarComoCliente("5511966665555@s.whatsapp.net");

    expect(pool.query).toHaveBeenCalledTimes(1); // só o SELECT
    expect(emitEvent).not.toHaveBeenCalled();
  });

  test("contato não encontrado → não faz nada, não quebra", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await expect(marcarComoCliente("5511955554444@s.whatsapp.net")).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  test("erro no banco não propaga (falha segura, best-effort)", async () => {
    pool.query.mockRejectedValueOnce(new Error("conexão recusada"));

    await expect(marcarComoCliente("5511944443333@s.whatsapp.net")).resolves.toBeUndefined();
  });

  test("aceita userId completo (@s.whatsapp.net/@lid) extraindo só os dígitos", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "c4", tags: [] }] })
      .mockResolvedValueOnce({ rows: [] });

    await marcarComoCliente("123456789@lid");

    expect(pool.query).toHaveBeenNthCalledWith(1, expect.any(String), ["123456789"]);
  });

  test("entrada vazia/sem dígitos → não chama o banco", async () => {
    await marcarComoCliente("");
    await marcarComoCliente(null);
    await marcarComoCliente("@s.whatsapp.net");

    expect(pool.query).not.toHaveBeenCalled();
  });
});
