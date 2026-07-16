/**
 * Bug relatado pelo usuário testando o painel: "algumas vezes estou
 * clicando fechar pedido 2 vezes, ou seja na primeira esta falhando" — na
 * prática não falhava: o botão "Resolvido" não tem nenhum loading/disable
 * (ver frontend/js/06-tickets.js), então 2 cliques rápidos disparavam 2
 * requisições PATCH status=resolvido em voo ao mesmo tempo. O backend
 * (patchTicket) não checava se o ticket JÁ estava resolvido antes de
 * disparar a pesquisa de satisfação de novo — o cliente recebia a
 * pergunta "De 1 a 5..." duas vezes seguidas.
 *
 * Fix: patchTicket só chama enviarPesquisaSatisfacao quando o status
 * ANTERIOR do ticket era diferente de "resolvido" — fechar um ticket já
 * fechado não deve reenviar a pesquisa.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/repositories/user.repository", () => ({ findById: jest.fn() }));
jest.mock("../src/config/whatsapp", () => ({ sendMessage: jest.fn().mockResolvedValue({ id: "wamid-1" }) }));
jest.mock("../src/services/history.service", () => ({ saveHistory: jest.fn().mockResolvedValue({ id: "h1", createdAt: new Date() }) }));
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn().mockResolvedValue({
    atendimento: {
      mensagemSaudacaoAtendente: "",
      mensagemPesquisaSatisfacao: "De 1 a 5, o quanto você ficou satisfeito com nosso atendimento?",
    },
  }),
}));

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const { sendMessage } = require("../src/config/whatsapp");
const ticketRoutes = require("../src/routes/ticket.routes");

let idCounter = 0;
function fakeId() { idCounter += 1; return idCounter; }

function buildState() { return { tickets: [] }; }
function findTicket(state, value) {
  return state.tickets.find(t => String(t.id) === value || t.protocolo === value);
}

function installFakePool(state) {
  pool.query.mockImplementation(async (text, params = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();

    if (/^SELECT nextval/.test(sql)) {
      return { rows: [{ numero: state.tickets.length + 1 }] };
    }
    if (/^INSERT INTO tickets/.test(sql)) {
      const row = {
        id: fakeId(), protocolo: params[0], user_id: params[1], customer_name: params[2],
        cpf: params[3], type: params[4], sector: params[5], description: params[6],
        status: params[7], assigned_to: params[8], assigned_to_name: params[9],
        created_at: params[10], updated_at: params[11],
        satisfaction_rating: null, satisfaction_asked_at: null, satisfaction_rated_at: null,
      };
      state.tickets.push(row);
      return { rows: [row] };
    }
    if (/^SELECT \* FROM tickets WHERE \(id = \$1::int OR protocolo = \$1(::text)?\) LIMIT 1/.test(sql)
      || /^SELECT \* FROM tickets WHERE protocolo = \$1 LIMIT 1/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [t] : [] };
    }
    if (/^UPDATE tickets\s+SET status = \$1/.test(sql)) {
      const t = findTicket(state, params[1]);
      if (!t) return { rows: [] };
      t.status = params[0];
      if (/assigned_to = NULL/.test(sql)) { t.assigned_to = null; t.assigned_to_name = null; }
      // Reabrir (status="aberto") também zera os campos de satisfação —
      // ver updateStatus em ticket.repository.js.
      if (/satisfaction_asked_at = NULL/.test(sql)) {
        t.satisfaction_rating = null;
        t.satisfaction_asked_at = null;
        t.satisfaction_rated_at = null;
      }
      return { rows: [t] };
    }
    if (/^UPDATE tickets\s+SET satisfaction_asked_at/.test(sql)) {
      const t = findTicket(state, params[0]);
      // Simula a reivindicação atômica real (WHERE ... AND
      // satisfaction_asked_at IS NULL): se já foi pedida antes, o UPDATE
      // não afeta nenhuma linha — RETURNING vazio.
      if (!t || t.satisfaction_asked_at) return { rows: [] };
      t.satisfaction_asked_at = new Date().toISOString();
      return { rows: [t] };
    }
    if (/^SELECT \* FROM tickets\s*(WHERE|ORDER)/.test(sql) || sql.startsWith("SELECT * FROM tickets")) {
      return { rows: [...state.tickets] };
    }
    if (/^DELETE FROM human_mode_sessions/.test(sql)) return { rows: [] };
    if (/^INSERT INTO human_mode_sessions/.test(sql)) return { rows: [] };

    throw new Error("Query não mapeada: " + sql);
  });
}

function buildApp(currentUser) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api", ticketRoutes);
  return app;
}

const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };

describe("patchTicket — não reenvia pesquisa de satisfação ao fechar um ticket já fechado", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
  });

  test("fechar 1x dispara a pesquisa 1x", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000000@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    const res = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    expect(res.status).toBe(200);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // Cenário exato reportado: clicar "Resolvido" 2x seguidas (sem loading no
  // botão) no mesmo ticket — o cliente recebia a pesquisa de satisfação 2x.
  test("clicar 'fechar' 2x seguidas no mesmo ticket já resolvido NÃO reenvia a pesquisa", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000001@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    const primeiro = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    const segundo  = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    expect(primeiro.status).toBe(200);
    expect(segundo.status).toBe(200); // não é erro — só não deve reenviar a pesquisa

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // O teste anterior ("clicar 2x seguidas") já passa graças ao atalho
  // "jaEstavaResolvido" em patchTicket — mas esse atalho sozinho não
  // fecha a race real (2 requisições que leem o ticket ANTES de
  // qualquer uma escrever, ex: vindas de botões/abas diferentes). Este
  // teste dispara as 2 requisições em paralelo de propósito (Promise.all),
  // sem esperar a 1ª terminar antes de iniciar a 2ª — só a reivindicação
  // atômica em askSatisfaction (ticket.repository.js) garante 1 envio só.
  test("2 requisições PATCH resolvido disparadas em paralelo (sem esperar uma terminar) → pesquisa só 1x", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000099@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    const [r1, r2] = await Promise.all([
      request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" }),
      request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("fechar → reabrir → fechar de novo dispara a pesquisa de novo (é um atendimento novo)", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000002@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    await request(app).patch(`/api/tickets/${id}`).send({ status: "aberto" });
    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
