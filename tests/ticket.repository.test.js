/**
 * Testes de ticket.repository.js — foco especial em findByIdOrProtocol /
 * updateStatus / assign / transfer, que hoje usam idOrProtocolWhere() para
 * comparar "id = $N::uuid" só quando o valor parece UUID (sem isso, o
 * padrão antigo "id::text = $1" invalidava o índice da chave primária —
 * ver commit "Otimiza queries de tickets, respostas rápidas e broadcast").
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const repo = require("../src/repositories/ticket.repository");

const UUID = "123e4567-e89b-12d3-a456-426614174000";
const PROTOCOLO = "2026-0042";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("create", () => {
  test("insere com os campos esperados e devolve o ticket mapeado", async () => {
    const row = {
      id: UUID, protocolo: PROTOCOLO, user_id: "55999@s.whatsapp.net",
      customer_name: "Cliente", cpf: "000", type: "orcamento", sector: "vendas",
      description: "desc", status: "aberto", assigned_to: null, assigned_to_name: null,
      created_at: new Date(), updated_at: new Date()
    };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await repo.create({
      protocolo: PROTOCOLO, userId: "55999@s.whatsapp.net", customerName: "Cliente",
      cpf: "000", type: "orcamento", sector: "vendas", description: "desc"
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO tickets/);
    expect(params[0]).toBe(PROTOCOLO);
    expect(result).toMatchObject({ id: UUID, protocolo: PROTOCOLO, status: "aberto" });
  });
});

describe("findByIdOrProtocol", () => {
  test("valor em formato UUID: compara id = $1::uuid OU protocolo = $1 (usa índice da PK)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: UUID, protocolo: PROTOCOLO }] });

    await repo.findByIdOrProtocol(UUID);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\(id = \$1::uuid OR protocolo = \$1\)/);
    expect(sql).not.toMatch(/id::text/);
    expect(params).toEqual([UUID]);
  });

  test("valor que NÃO é UUID (protocolo): compara só protocolo = $1, sem tocar em id", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: UUID, protocolo: PROTOCOLO }] });

    await repo.findByIdOrProtocol(PROTOCOLO);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/WHERE protocolo = \$1/);
    expect(sql).not.toMatch(/id\s*=/);
    expect(params).toEqual([PROTOCOLO]);
  });

  test("não encontrado retorna null", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await repo.findByIdOrProtocol(PROTOCOLO);
    expect(result).toBeNull();
  });
});

describe("updateStatus", () => {
  test("usa idOrProtocolWhere no índice $2 e devolve o ticket atualizado", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: UUID, status: "resolvido" }] });

    const result = await repo.updateStatus(UUID, "resolvido");

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET status = \$1/);
    expect(sql).toMatch(/\(id = \$2::uuid OR protocolo = \$2\)/);
    expect(params).toEqual(["resolvido", UUID]);
    expect(result).toMatchObject({ status: "resolvido" });
  });

  test("ticket inexistente retorna null", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const result = await repo.updateStatus(PROTOCOLO, "cancelado");
    expect(result).toBeNull();
  });
});

describe("assign", () => {
  test("ticket inexistente → notFound", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // exists check

    const result = await repo.assign(PROTOCOLO, { id: "u1", nome: "Ana" });

    expect(result).toEqual({ notFound: true });
    expect(pool.query).toHaveBeenCalledTimes(1); // não chega a tentar o UPDATE
  });

  test("ticket já atribuído → alreadyAssigned (sem tentar UPDATE)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: UUID, assigned_to: "outro-user" }] });

    const result = await repo.assign(UUID, { id: "u1", nome: "Ana" });

    expect(result).toEqual({ alreadyAssigned: true });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("ticket livre → assume com sucesso", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID, assigned_to: null }] }) // exists check
      .mockResolvedValueOnce({ rows: [{ id: UUID, assigned_to: "u1", assigned_to_name: "Ana", status: "em_andamento" }] }); // update

    const result = await repo.assign(UUID, { id: "u1", nome: "Ana" });

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = pool.query.mock.calls[1];
    expect(updateSql).toMatch(/SET assigned_to = \$1/);
    expect(updateSql).toMatch(/\(id = \$3::uuid OR protocolo = \$3\)/);
    expect(updateSql).toMatch(/AND assigned_to IS NULL/);
    expect(updateParams).toEqual(["u1", "Ana", UUID]);
    expect(result).toMatchObject({ status: "em_andamento" });
  });

  test("corrida: UPDATE não afeta linha (outro atendente assumiu entre o check e o update) → alreadyAssigned", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: UUID, assigned_to: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await repo.assign(UUID, { id: "u1", nome: "Ana" });
    expect(result).toEqual({ alreadyAssigned: true });
  });
});

describe("transfer", () => {
  test("transferência para setor (sem usuário-alvo): status volta para aberto", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: UUID, sector: "financeiro", assigned_to: null, status: "aberto" }]
    });

    const result = await repo.transfer(UUID, "financeiro", null);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\(id = \$5::uuid OR protocolo = \$5\)/);
    expect(params).toEqual(["financeiro", null, null, "aberto", UUID]);
    expect(result).toMatchObject({ sector: "financeiro", status: "aberto" });
  });

  test("transferência direta para atendente: usa o setor do atendente-alvo e status em_andamento", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: UUID, sector: "vendas", assigned_to: "u2", status: "em_andamento" }]
    });

    const targetUser = { id: "u2", nome: "Bruno", sector: "vendas" };
    await repo.transfer(UUID, "ignorado", targetUser);

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(["vendas", "u2", "Bruno", "em_andamento", UUID]);
  });
});

describe("findAll", () => {
  test("sem filtros: nenhum WHERE, limit/offset default", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await repo.findAll({});

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([500, 0]);
  });

  test("com status e search: WHERE combina os dois filtros", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await repo.findAll({ status: "aberto", search: "João", limit: 20, offset: 40 });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = \$1/);
    expect(sql).toMatch(/LOWER\(customer_name\) LIKE \$2/);
    expect(params).toEqual(["aberto", "%joão%", 20, 40]);
  });
});

describe("stats", () => {
  test("agrega contagem por status sem filtro de data", async () => {
    const row = { total: 10, aberto: 2, em_andamento: 1, resolvido: 5, cancelado: 2 };
    pool.query.mockResolvedValueOnce({ rows: [row] });

    const result = await repo.stats({});

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual([]);
    expect(result).toEqual(row);
  });
});
