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
    // BUG DE FIXTURE ACHADO (2026-08-14, ao adicionar o bloqueio de admin):
    // hasSurveyAskedToday() (ticket.repository.js, feature de 30/07 — "só 1
    // pesquisa por cliente ao dia") nunca tinha um handler aqui — toda
    // chamada de enviarPesquisaSatisfacao caía no "Query não mapeada" e era
    // engolida pelo catch best-effort, fazendo TODOS os testes deste
    // arquivo falharem silenciosamente com "sendMessage não foi chamado",
    // mesmo sem relação nenhuma com a mudança de admin. Simplificado: já que
    // os testes daqui não avançam o relógio entre chamadas no mesmo dia,
    // basta checar se já existe satisfaction_asked_at pra esse userId.
    if (/^SELECT 1 FROM tickets\s+WHERE user_id = \$1\s+AND satisfaction_asked_at IS NOT NULL/.test(sql)) {
      const t = state.tickets.find(x => x.user_id === params[0] && x.satisfaction_asked_at);
      return { rows: t ? [{ "?column?": 1 }] : [] };
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

// PEDIDO DO USUÁRIO (2026-08-14): "sempre que eu fechar algum atendimento
// pelo usuário administrador, independentemente, não solte pesquisa
// satisfatória" — fechar como perfil "admin" agora NUNCA dispara a pesquisa
// (ver fechadoPeloAdmin em ticket.controller.js), incondicionalmente. Os
// testes deste arquivo testam a lógica de DEDUPLICAÇÃO em si (não reenviar
// pra um ticket já fechado, respeitar a janela de reabertura etc.) — usar
// um perfil "admin" aqui esconderia essa lógica atrás do novo bloqueio
// incondicional (a pesquisa nunca sairia, dedup ou não). Por isso o ator
// usado para fechar os tickets neste arquivo é "atendente", não "admin" — a
// cobertura específica do bloqueio por admin fica no describe no final
// deste arquivo.
const ATENDENTE = { id: "at-1", nome: "Bruno Atendente", perfil: "atendente", sector: "vendas" };

describe("patchTicket — não reenvia pesquisa de satisfação ao fechar um ticket já fechado", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
  });

  test("fechar 1x dispara a pesquisa 1x", async () => {
    const app = buildApp(ATENDENTE);
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
    const app = buildApp(ATENDENTE);
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
    const app = buildApp(ATENDENTE);
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

  // PEDIDO DO USUÁRIO (2026-07-27): "quando clicar em reabrir... não mande a
  // pesquisa de satisfação por determinado tempo" — mudou o comportamento
  // que este teste travava antes (reabertura manual sempre disparava a
  // pesquisa de novo). Fechar de novo DENTRO da janela de reabertura
  // (TICKET_REOPEN_WINDOW_MINUTOS, padrão 240min/4h) agora NÃO reenvia — ver
  // foiReabertoManualmenteRecente() em ticket.service.js.
  test("fechar → reabrir → fechar de novo DENTRO da janela → NÃO reenvia a pesquisa", async () => {
    const app = buildApp(ATENDENTE);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000002@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    await request(app).patch(`/api/tickets/${id}`).send({ status: "aberto" });
    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  test("fechar → reabrir → fechar de novo bem DEPOIS da janela (240min+) → dispara a pesquisa de novo (atendimento genuinamente novo)", async () => {
    const app = buildApp(ATENDENTE);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000003@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    await request(app).patch(`/api/tickets/${id}`).send({ status: "aberto" });

    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, "now").mockImplementation(() => realNow + 241 * 60 * 1000);
    try {
      await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// PEDIDO DO USUÁRIO (2026-08-14): "sempre que eu fechar algum atendimento
// pelo usuário administrador, independentemente, não solte pesquisa
// satisfatória". Bloqueio incondicional (ver fechadoPeloAdmin em
// ticket.controller.js) — testado aqui em cenários que, com um atendente
// comum, disparariam a pesquisa normalmente (ver describe acima), pra
// confirmar que é o PERFIL de quem fecha que corta o envio, não outra
// condição já existente (skipSurvey, dedup etc.).
describe("patchTicket — fechar como perfil admin nunca dispara a pesquisa de satisfação", () => {
  let state;
  const ADMIN = { id: "admin-1", nome: "Ana Admin", perfil: "admin", sector: "geral" };

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
  });

  test("1º fechamento do dia, sem skipSurvey, sem reabertura recente → mesmo assim NÃO envia", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000010@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    const res = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe("resolvido");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("ticket criado por um atendente, mas fechado pelo admin → não envia (o perfil de quem FECHA que importa)", async () => {
    const atendente = { id: "at-2", nome: "Carla", perfil: "atendente", sector: "vendas" };
    const criado = await request(buildApp(atendente)).post("/api/tickets")
      .send({ userId: "5511900000011@s.whatsapp.net", type: "orcamento" });
    const id = criado.body.ticket.id;

    const res = await request(buildApp(ADMIN)).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("supervisor (perfil diferente de admin) fechando continua enviando normalmente — bloqueio é só pra 'admin'", async () => {
    const supervisor = { id: "sup-1", nome: "Sued Supervisor", perfil: "supervisor", sector: "geral" };
    const app = buildApp(supervisor);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "5511900000012@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    const res = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
