/**
 * Testes de _buscarNomeCliente (main.flow.js) — pedido do usuário: "ele
 * ainda está entendendo o contato como nome informado antes, preciso que
 * ele capte o nome do contato mesmo".
 *
 * A saudação usava tickets.customer_name (nome digitado manualmente num
 * orçamento antigo, pode ficar "preso" a um atendimento anterior) antes de
 * olhar pro nome real do contato. Prioridade nova:
 *   contacts.nome (pushName do WhatsApp, auto-registrado)
 *   > tickets.customer_name (digitado, fallback)
 *   > history.contact_name (cópia mais antiga do pushName, último fallback)
 *
 * Arquivo isolado (não usa o mock global de tests/main.flow.test.js) porque
 * precisa de um mock de pool.query condicional por tabela.
 *
 * A saudação também passou a usar saudacaoPorHorario() (Bom dia/Boa
 * tarde/Boa noite conforme o horário real) em vez do "Olá" fixo — por isso
 * as asserções abaixo usam regex aceitando qualquer uma das três.
 */
jest.mock("../src/services/session.service", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn().mockResolvedValue(undefined),
  clearSession: jest.fn().mockResolvedValue(undefined),
  finalizarComTicket: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/ticket.service", () => ({ createTicket: jest.fn() }));
jest.mock("../src/services/notificacao.service", () => ({
  notificarAtendente: jest.fn(),
  notificarSeDisponivel: jest.fn(),
}));
jest.mock("../src/services/ai.service", () => ({ perguntarIA: jest.fn(), iaEmFalhaCritica: jest.fn().mockReturnValue(false) }));
jest.mock("../src/services/botConfig.service", () => ({
  getBotConfig: jest.fn().mockResolvedValue({ iaAtiva: true }),
}));
jest.mock("../src/flows/vendas.flow", () => {
  const fn = jest.fn().mockResolvedValue(null);
  fn.finalizarOrcamento = jest.fn().mockResolvedValue("ok");
  return fn;
});
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/whatsapp/lid-map", () => ({
  getProfilePhotoCandidates: jest.fn(userId => [userId]),
}));

const pool = require("../src/database/postgres");
const sessionService = require("../src/services/session.service");
const mainFlow = require("../src/flows/main.flow");

const USER_ID = "5511999999999@s.whatsapp.net";

function mockQueries({ contatoNome = null, ticketNome = null, historicoNome = null } = {}) {
  pool.query.mockImplementation((sql) => {
    if (sql.includes("FROM contacts")) {
      return Promise.resolve({ rows: contatoNome ? [{ nome: contatoNome }] : [] });
    }
    if (sql.includes("FROM tickets")) {
      return Promise.resolve({ rows: ticketNome ? [{ customer_name: ticketNome }] : [] });
    }
    if (sql.includes("FROM history")) {
      return Promise.resolve({ rows: historicoNome ? [{ contact_name: historicoNome }] : [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe("main.flow — _buscarNomeCliente prioriza o nome real do contato", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionService.getSession.mockReturnValue({ sector: "main" });
  });

  // A saudação usa só o primeiro nome (main.flow.js: nomeSalvo.trim().split(" ")[0]),
  // por isso as asserções checam o primeiro token de cada nome, não a string inteira.

  test("contacts.nome existe → usado na saudação, mesmo com nome diferente em tickets/history", async () => {
    mockQueries({ contatoNome: "Design / Marketing", ticketNome: "Hickson Martins", historicoNome: "Outro Nome" });

    const resposta = await mainFlow({ userId: USER_ID, message: "bom dia" });

    expect(resposta).toMatch(/(Bom dia|Boa tarde|Boa noite), \*Design\*/);
    expect(resposta).not.toContain("Hickson");
  });

  test("sem contacts.nome, mas com tickets.customer_name → usa o nome do ticket (fallback)", async () => {
    mockQueries({ contatoNome: null, ticketNome: "Hickson Martins", historicoNome: "Outro Nome" });

    const resposta = await mainFlow({ userId: USER_ID, message: "bom dia" });

    expect(resposta).toMatch(/(Bom dia|Boa tarde|Boa noite), \*Hickson\*/);
  });

  test("sem contacts.nome nem tickets.customer_name → usa history.contact_name (último fallback)", async () => {
    mockQueries({ contatoNome: null, ticketNome: null, historicoNome: "Contato Antigo" });

    const resposta = await mainFlow({ userId: USER_ID, message: "bom dia" });

    expect(resposta).toMatch(/(Bom dia|Boa tarde|Boa noite), \*Contato\*/);
  });

  test("nome de contato só com dígitos (placeholder de telefone) é ignorado, cai pro fallback", async () => {
    mockQueries({ contatoNome: "5511999999999", ticketNome: "Hickson Martins" });

    const resposta = await mainFlow({ userId: USER_ID, message: "bom dia" });

    expect(resposta).toMatch(/(Bom dia|Boa tarde|Boa noite), \*Hickson\*/);
    expect(resposta).not.toContain("5511999999999");
  });

  test("cliente sem nome em lugar nenhum → saudação genérica, sem quebrar", async () => {
    mockQueries({});

    const resposta = await mainFlow({ userId: USER_ID, message: "bom dia" });

    expect(resposta).toContain("Bem-vindo à");
  });
});
