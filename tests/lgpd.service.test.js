/**
 * Testes de lgpd.service — anonimização e exclusão de dados pessoais do
 * titular, espalhados em contacts/history/tickets. Mocka o client de
 * transação do pool (connect/query/release) para verificar que:
 * 1) as 3 tabelas são tocadas com o telefone normalizado (só dígitos);
 * 2) uma falha em qualquer query causa ROLLBACK, não COMMIT parcial.
 */
jest.mock("../src/database/postgres", () => ({ connect: jest.fn() }));

const pool = require("../src/database/postgres");
const { anonymizeCustomerData, eraseCustomerData } = require("../src/services/lgpd.service");

function mockClient(queryImpl) {
  const client = {
    query: jest.fn(queryImpl),
    release: jest.fn()
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

describe("lgpd.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("anonymizeCustomerData", () => {
    test("normaliza o telefone (remove máscara) antes de tocar as tabelas", async () => {
      const client = mockClient(() => ({ rowCount: 1, rows: [] }));

      await anonymizeCustomerData("(11) 98888-7777");

      // BEGIN, UPDATE contacts, UPDATE history, UPDATE tickets, COMMIT = 5 chamadas
      expect(client.query).toHaveBeenCalledTimes(5);
      expect(client.query.mock.calls[0][0]).toBe("BEGIN");
      expect(client.query.mock.calls[1][1]).toEqual(expect.arrayContaining(["11988887777"]));
      expect(client.query.mock.calls[4][0]).toBe("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    test("retorna a contagem de linhas afetadas em cada tabela", async () => {
      const client = mockClient((sql) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rowCount: 0, rows: [] };
        if (/UPDATE contacts/.test(sql)) return { rowCount: 1, rows: [] };
        if (/UPDATE history/.test(sql)) return { rowCount: 3, rows: [] };
        if (/UPDATE tickets/.test(sql)) return { rowCount: 2, rows: [] };
        return { rowCount: 0, rows: [] };
      });

      const resultado = await anonymizeCustomerData("11988887777");

      expect(resultado).toEqual({ contacts: 1, history: 3, tickets: 2 });
      expect(client.query).toHaveBeenCalledTimes(5);
    });

    test("faz ROLLBACK e propaga o erro se uma query falhar", async () => {
      const client = mockClient((sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return Promise.resolve({});
        throw new Error("falha simulada no banco");
      });

      await expect(anonymizeCustomerData("11988887777")).rejects.toThrow(/falha simulada/);

      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.query).not.toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });

    test("rejeita telefone vazio/inválido sem nem abrir transação", async () => {
      await expect(anonymizeCustomerData("")).rejects.toThrow(/inválido/i);
      await expect(anonymizeCustomerData("abc")).rejects.toThrow(/inválido/i);
      expect(pool.connect).not.toHaveBeenCalled();
    });
  });

  describe("eraseCustomerData", () => {
    test("apaga nas 3 tabelas e faz commit", async () => {
      const client = mockClient(() => ({ rowCount: 1, rows: [] }));

      await eraseCustomerData("11988887777");

      expect(client.query).toHaveBeenCalledTimes(5);
      expect(client.query.mock.calls[0][0]).toBe("BEGIN");
      expect(client.query.mock.calls[1][0]).toMatch(/DELETE FROM history/);
      expect(client.query.mock.calls[2][0]).toMatch(/DELETE FROM tickets/);
      expect(client.query.mock.calls[3][0]).toMatch(/DELETE FROM contacts/);
      expect(client.query.mock.calls[4][0]).toBe("COMMIT");
    });

    test("faz ROLLBACK se uma das exclusões falhar", async () => {
      const client = mockClient((sql) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") return Promise.resolve({});
        if (/DELETE FROM history/.test(sql)) return Promise.resolve({ rowCount: 2 });
        throw new Error("falha simulada no delete de tickets");
      });

      await expect(eraseCustomerData("11988887777")).rejects.toThrow(/falha simulada/);
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });
  });
});
