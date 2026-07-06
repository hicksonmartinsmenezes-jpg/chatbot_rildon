/**
 * Testes de unidade para ticketRepository.stats — a função que alimenta os
 * cards de "Total / Encerrados / Pendentes" do Dashboard e das Métricas.
 *
 * Foco: a lógica de filtro de PERÍODO (hoje / mês / all-time), que já causou
 * confusão real (ex.: "Encerrados" mostrando hoje vs. all-time). O pool do
 * Postgres é mockado — testamos a construção do WHERE e dos parâmetros sem
 * depender de banco, para rodar em qualquer CI.
 */

// Mocka o módulo do pool ANTES de importar o repositório.
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const ticketRepository = require("../src/repositories/ticket.repository");

const FAKE_ROW = { total: 10, aberto: 2, em_andamento: 1, resolvido: 5, cancelado: 2 };

beforeEach(() => {
  pool.query.mockResolvedValue({ rows: [FAKE_ROW] });
});

describe("ticketRepository.stats — filtro de período", () => {
  test("sem filtro de data → all-time (nenhum WHERE, nenhum parâmetro)", async () => {
    await ticketRepository.stats({});
    const [sql, params] = pool.query.mock.calls[0];

    expect(params).toEqual([]);
    // Não deve haver cláusula WHERE de data após "FROM tickets".
    // (os "FILTER (WHERE status = ...)" do SELECT sempre existem — por isso a
    // asserção é específica ao WHERE de filtro, não a qualquer "WHERE".)
    expect(sql).not.toMatch(/FROM tickets\s+WHERE/);
    expect(sql).not.toMatch(/::date/);
  });

  test("apenas dateStart → WHERE com >= $1 e um único parâmetro", async () => {
    await ticketRepository.stats({ dateStart: "2026-06-01" });
    const [sql, params] = pool.query.mock.calls[0];

    expect(params).toEqual(["2026-06-01"]);
    expect(sql).toMatch(/WHERE/);
    expect(sql).toMatch(/>=\s*\$1::date/);
    expect(sql).not.toMatch(/<=\s*\$2/);
  });

  test("dateStart + dateEnd → intervalo com >= $1 AND <= $2 e dois parâmetros", async () => {
    await ticketRepository.stats({ dateStart: "2026-06-01", dateEnd: "2026-06-30" });
    const [sql, params] = pool.query.mock.calls[0];

    expect(params).toEqual(["2026-06-01", "2026-06-30"]);
    expect(sql).toMatch(/>=\s*\$1::date/);
    expect(sql).toMatch(/<=\s*\$2::date/);
    expect(sql).toMatch(/AND/);
  });

  test("mesma data em start e end → intervalo de um dia (cenário 'hoje')", async () => {
    await ticketRepository.stats({ dateStart: "2026-07-06", dateEnd: "2026-07-06" });
    const [, params] = pool.query.mock.calls[0];

    expect(params).toEqual(["2026-07-06", "2026-07-06"]);
  });
});

describe("ticketRepository.stats — formato do retorno", () => {
  test("retorna a primeira linha do resultado", async () => {
    const out = await ticketRepository.stats({});
    expect(out).toEqual(FAKE_ROW);
  });

  test("SELECT agrega os quatro status via COUNT FILTER", async () => {
    await ticketRepository.stats({});
    const [sql] = pool.query.mock.calls[0];

    expect(sql).toMatch(/FILTER \(WHERE status = 'aberto'\)/);
    expect(sql).toMatch(/FILTER \(WHERE status = 'em_andamento'\)/);
    expect(sql).toMatch(/FILTER \(WHERE status = 'resolvido'\)/);
    expect(sql).toMatch(/FILTER \(WHERE status = 'cancelado'\)/);
  });
});

describe("ticketRepository.stats — proteção de timezone (anti-injeção)", () => {
  const ORIGINAL_TZ = process.env.TZ_NEGOCIO;
  afterEach(() => { process.env.TZ_NEGOCIO = ORIGINAL_TZ; });

  test("TZ malicioso é ignorado e cai no padrão seguro (America/Maceio)", async () => {
    process.env.TZ_NEGOCIO = "'; DROP TABLE tickets;--";
    await ticketRepository.stats({ dateStart: "2026-06-01" });
    const [sql] = pool.query.mock.calls[0];

    expect(sql).toMatch(/America\/Maceio/);
    expect(sql).not.toMatch(/DROP TABLE/);
  });
});
