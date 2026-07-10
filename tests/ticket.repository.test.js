/**
 * Testes de ticket.repository.js — foco especial em findByIdOrProtocol /
 * updateStatus / assign / transfer, que usam idOrProtocolWhere() para
 * comparar "id = $N::int" só quando o valor parece o id numérico de tickets
 * (id é SERIAL/integer — ver schema.sql; NÃO é uuid, ao contrário de
 * users/contacts). Sem esse cast no parâmetro (e não na coluna), o padrão
 * antigo "id::text = $1" invalidava o índice da chave primária.
 *
 * IMPORTANTE: um bug real já aconteceu aqui — uma versão anterior desta
 * função testava formato UUID em vez de inteiro, então NUNCA batia com o
 * id real de um ticket (que é sempre um número tipo "42"), e toda busca
 * por id caía silenciosamente no branch "protocolo = $N", que nunca
 * corresponde a um id numérico. Resultado: assumir/transferir/fechar
 * ticket por id retornava 404 sempre, para qualquer perfil. Os testes
 * antigos usavam um UUID fabricado como fixture e não pegaram isso —
 * por isso aqui o ID de fixture é deliberadamente um inteiro (como na
 * tabela real), não um UUID.
 *
 * IMPORTANTE (2): um segundo bug real aconteceu logo depois — a correção
 * acima usava "(id = $N::int OR protocolo = $N)" sem cast na segunda
 * ocorrência do mesmo parâmetro. O Postgres resolve o tipo de um parâmetro
 * nomeado uma única vez por statement; como a primeira ocorrência fixa o
 * tipo como "int" (por causa do "::int"), a segunda ocorrência, sem cast,
 * tentava comparar a coluna varchar "protocolo" com um valor já tipado
 * como integer — erro em runtime "operator does not exist: character
 * varying = integer", em produção, em toda chamada. Corrigido dando cast
 * explícito também na segunda ocorrência ("::text"). Os testes abaixo
 * verificam a string SQL exata gerada, então teriam pego isso se já
 * existissem antes — mas não pegam erros de TIPO em tempo de execução do
 * Postgres real, já que o pool aqui é mockado. Verificação desse tipo de
 * bug (tipo compartilhado de parâmetro) precisa rodar contra um Postgres
 * de verdade, não só o mock.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));

const pool = require("../src/database/postgres");
const repo = require("../src/repositories/ticket.repository");

const ID = "42"; // tickets.id é SERIAL — o valor real é sempre um inteiro como este
const PROTOCOLO = "2026-0042";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("create", () => {
  test("insere com os campos esperados e devolve o ticket mapeado", async () => {
    const row = {
      id: 42, protocolo: PROTOCOLO, user_id: "55999@s.whatsapp.net",
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
    expect(result).toMatchObject({ id: 42, protocolo: PROTOCOLO, status: "aberto" });
  });
});

describe("findByIdOrProtocol", () => {
  test("valor numérico (id real de tickets): compara id = $1::int OU protocolo = $1::text (usa índice da PK, sem conflito de tipo do parâmetro)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, protocolo: PROTOCOLO }] });

    await repo.findByIdOrProtocol(ID);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\(id = \$1::int OR protocolo = \$1::text\)/);
    expect(sql).not.toMatch(/id::text/);
    expect(params).toEqual([ID]);
  });

  test("valor não-numérico (protocolo): compara só protocolo = $1, sem tocar em id", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, protocolo: PROTOCOLO }] });

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
    pool.query.mockResolvedValueOnce({ rows: [{ id: 42, status: "resolvido" }] });

    const result = await repo.updateStatus(ID, "resolvido");

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET status = \$1/);
    expect(sql).toMatch(/\(id = \$2::int OR protocolo = \$2::text\)/);
    expect(params).toEqual(["resolvido", ID]);
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

  test("ticket já atribuído → alreadyAssigned com o nome de quem assumiu (sem tentar UPDATE)", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, assigned_to: "outro-user", assigned_to_name: "Bruno" }]
    });

    const result = await repo.assign(ID, { id: "u1", nome: "Ana" });

    expect(result).toEqual({ alreadyAssigned: true, assignedToName: "Bruno" });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test("corrida: UPDATE não afeta linha → alreadyAssigned traz o nome de quem venceu a corrida", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, assigned_to: null, assigned_to_name: null }] }) // exists check
      .mockResolvedValueOnce({ rows: [] }) // update não afeta linha (corrida)
      .mockResolvedValueOnce({ rows: [{ assigned_to_name: "Carla" }] }); // re-consulta pra achar o vencedor

    const result = await repo.assign(ID, { id: "u1", nome: "Ana" });

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ alreadyAssigned: true, assignedToName: "Carla" });
  });

  test("ticket livre → assume com sucesso", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, assigned_to: null }] }) // exists check
      .mockResolvedValueOnce({ rows: [{ id: 42, assigned_to: "u1", assigned_to_name: "Ana", status: "em_andamento" }] }); // update

    const result = await repo.assign(ID, { id: "u1", nome: "Ana" });

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [updateSql, updateParams] = pool.query.mock.calls[1];
    expect(updateSql).toMatch(/SET assigned_to = \$1/);
    expect(updateSql).toMatch(/\(id = \$3::int OR protocolo = \$3::text\)/);
    expect(updateSql).toMatch(/AND assigned_to IS NULL/);
    expect(updateParams).toEqual(["u1", "Ana", ID]);
    expect(result).toMatchObject({ status: "em_andamento" });
  });

});

describe("transfer", () => {
  test("transferência para setor (sem usuário-alvo): status volta para aberto", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, sector: "financeiro", assigned_to: null, status: "aberto" }]
    });

    const result = await repo.transfer(ID, "financeiro", null);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/\(id = \$5::int OR protocolo = \$5::text\)/);
    expect(params).toEqual(["financeiro", null, null, "aberto", ID]);
    expect(result).toMatchObject({ sector: "financeiro", status: "aberto" });
  });

  test("transferência direta para atendente: usa o setor do atendente-alvo e status em_andamento", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 42, sector: "vendas", assigned_to: "u2", status: "em_andamento" }]
    });

    const targetUser = { id: "u2", nome: "Bruno", sector: "vendas" };
    await repo.transfer(ID, "ignorado", targetUser);

    const [, params] = pool.query.mock.calls[0];
    expect(params).toEqual(["vendas", "u2", "Bruno", "em_andamento", ID]);
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
