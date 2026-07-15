/**
 * Testes do fix "assumir/transferir/fechar/devolver ao bot não atualizam
 * em outras sessões do painel" (relatado pelo usuário para perfil
 * atendente): o backend nunca emitia nenhum evento de socket nessas
 * ações — cada aba só via a própria mudança via reload local; outras
 * sessões conectadas (outro atendente, painel admin observando a mesma
 * conversa) ficavam com o estado antigo até o poll de 30s.
 *
 * Fix: ticket.controller.js emite "ticket_atualizado" após assign/transfer/
 * patch de status; humanMode.service.js emite "humanmode_atualizado" em
 * ativar()/desativar() (cobre assumir, devolver ao bot, e fechamento de
 * ticket que também desativa o modo humano).
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn() }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("../src/repositories/user.repository", () => ({ findById: jest.fn() }));

const express = require("express");
const request = require("supertest");

const pool = require("../src/database/postgres");
const { emitEvent } = require("../src/services/socket.service");
const humanMode = require("../src/services/humanMode.service");
const ticketRoutes = require("../src/routes/ticket.routes");
const ticketService = require("../src/services/ticket.service");

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
        created_at: params[10], updated_at: params[11]
      };
      state.tickets.push(row);
      return { rows: [row] };
    }
    if (/^SELECT \* FROM tickets WHERE \(id = \$1::int OR protocolo = \$1(::text)?\) LIMIT 1/.test(sql)
      || /^SELECT \* FROM tickets WHERE protocolo = \$1 LIMIT 1/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [t] : [] };
    }
    if (/^SELECT id, assigned_to, assigned_to_name FROM tickets WHERE/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [{ id: t.id, assigned_to: t.assigned_to, assigned_to_name: t.assigned_to_name }] : [] };
    }
    if (/^SELECT assigned_to_name FROM tickets WHERE/.test(sql)) {
      const t = findTicket(state, params[0]);
      return { rows: t ? [{ assigned_to_name: t.assigned_to_name }] : [] };
    }
    if (/^UPDATE tickets\s+SET status = \$1/.test(sql)) {
      const t = findTicket(state, params[1]);
      if (!t) return { rows: [] };
      t.status = params[0];
      if (/assigned_to = NULL/.test(sql)) { t.assigned_to = null; t.assigned_to_name = null; }
      return { rows: [t] };
    }
    if (/^UPDATE tickets\s+SET assigned_to = \$1/.test(sql)) {
      const t = findTicket(state, params[2]);
      if (!t || t.assigned_to) return { rows: [] };
      t.assigned_to = params[0]; t.assigned_to_name = params[1]; t.status = "em_andamento";
      return { rows: [t] };
    }
    if (/^UPDATE tickets\s+SET sector\s+=/.test(sql)) {
      const t = findTicket(state, params[4]);
      if (!t) return { rows: [] };
      t.sector = params[0]; t.assigned_to = params[1]; t.assigned_to_name = params[2]; t.status = params[3];
      return { rows: [t] };
    }
    if (/^SELECT \* FROM tickets\s*(WHERE|ORDER)/.test(sql) || sql.startsWith("SELECT * FROM tickets")) {
      return { rows: [...state.tickets] };
    }
    if (/^SELECT \* FROM tickets WHERE user_id = ANY/.test(sql)) {
      const ids = new Set(params[0] || []);
      return { rows: state.tickets.filter(t => ids.has(t.user_id)) };
    }
    if (/^DELETE FROM human_mode_sessions/.test(sql)) return { rows: [] };
    if (/^INSERT INTO human_mode_sessions/.test(sql)) return { rows: [] };
    if (/^INSERT INTO lid_map/.test(sql)) return { rows: [] };

    if (/COUNT\(\*\)::int AS total/.test(sql) && /FILTER \(WHERE status = 'aberto'\)/.test(sql)) {
      const count = st => state.tickets.filter(t => t.status === st).length;
      return {
        rows: [{
          total: state.tickets.length,
          aberto: count("aberto"),
          em_andamento: count("em_andamento"),
          resolvido: count("resolvido"),
          cancelado: count("cancelado")
        }]
      };
    }
    if (/COALESCE\(sector,'geral'\) AS setor/.test(sql)) return { rows: [] };
    if (/assigned_to_name AS nome/.test(sql)) return { rows: [] };
    if (/WHERE DATE\(created_at AT TIME ZONE \$1\) = CURRENT_DATE/.test(sql)) return { rows: [{ total: 0 }] };

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

describe("ticket_atualizado / humanmode_atualizado — sincronização em tempo real", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    state = buildState();
    installFakePool(state);
  });

  test("assumir ticket emite ticket_atualizado E humanmode_atualizado(active:true)", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "55999@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;
    emitEvent.mockClear();

    const res = await request(app).patch(`/api/tickets/${id}/assign`);
    expect(res.status).toBe(200);

    const ticketEvent = emitEvent.mock.calls.find(c => c[0] === "ticket_atualizado");
    expect(ticketEvent).toBeTruthy();
    expect(ticketEvent[1].ticket).toMatchObject({ id, status: "em_andamento" });

    const humanModeEvent = emitEvent.mock.calls.find(c => c[0] === "humanmode_atualizado");
    expect(humanModeEvent).toBeTruthy();
    expect(humanModeEvent[1]).toMatchObject({ userId: "55999@s.whatsapp.net", active: true });
  });

  test("transferir ticket emite ticket_atualizado", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "55988@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;
    emitEvent.mockClear();

    const res = await request(app).patch(`/api/tickets/${id}/transfer`).send({ sector: "suporte" });
    expect(res.status).toBe(200);

    const ticketEvent = emitEvent.mock.calls.find(c => c[0] === "ticket_atualizado");
    expect(ticketEvent).toBeTruthy();
    expect(ticketEvent[1].ticket).toMatchObject({ id, sector: "suporte" });
  });

  test("fechar ticket (status=resolvido) emite ticket_atualizado E humanmode_atualizado(active:false)", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "55977@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;
    await request(app).patch(`/api/tickets/${id}/assign`); // ativa o modo humano primeiro
    emitEvent.mockClear();

    const res = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    expect(res.status).toBe(200);

    const ticketEvent = emitEvent.mock.calls.find(c => c[0] === "ticket_atualizado");
    expect(ticketEvent).toBeTruthy();
    expect(ticketEvent[1].ticket).toMatchObject({ id, status: "resolvido" });

    const humanModeEvent = emitEvent.mock.calls.find(c => c[0] === "humanmode_atualizado");
    expect(humanModeEvent).toBeTruthy();
    expect(humanModeEvent[1]).toMatchObject({ userId: "55977@s.whatsapp.net", active: false });
  });

  test("devolver ao bot (humanMode.desativar direto) emite humanmode_atualizado(active:false)", () => {
    humanMode.ativar("55966@s.whatsapp.net", { agentName: "Bruno" });
    emitEvent.mockClear();

    humanMode.desativar("55966@s.whatsapp.net", "painel");

    expect(emitEvent).toHaveBeenCalledWith(
      "humanmode_atualizado",
      expect.objectContaining({ userId: "55966@s.whatsapp.net", active: false })
    );
  });

  // BUG CORRIGIDO (relatado pelo usuário): cliente que manda mensagem depois
  // do atendimento fechado tem o ticket reaberto automaticamente
  // (reopenTicketIfClosed em ticket.service.js), mas essa reabertura
  // atualizava o banco direto pelo repository, sem passar pelo
  // ticket.controller.js — nunca emitia "ticket_atualizado", então o painel
  // não via o cliente voltar pra "Pendentes" nem a notificação, só depois
  // de um reload manual.
  test("reopenTicketIfClosed emite ticket_atualizado quando reabre um ticket fechado", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "55955@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    emitEvent.mockClear();

    const reabriu = await ticketService.reopenTicketIfClosed("55955@s.whatsapp.net");
    expect(reabriu).toBe(true);

    const ticketEvent = emitEvent.mock.calls.find(c => c[0] === "ticket_atualizado");
    expect(ticketEvent).toBeTruthy();
    expect(ticketEvent[1].ticket).toMatchObject({ id, status: "aberto" });
  });

  // BUG CORRIGIDO (relatado pelo usuário): "fechei, cliente mandou mensagem
  // de novo, não reabriu" — testado com hard refresh no meio, mas o refresh
  // não tinha nada a ver: o cooldown de 60s de reopenTicketIfClosed ficava
  // ativo após a 1ª reabertura e NUNCA era limpo nesse caminho. Se o ticket
  // fechasse de novo dentro dessa janela (fluxo normal de teste rápido) e o
  // cliente mandasse outra mensagem, o cooldown ainda vigente bloqueava o
  // reopen silenciosamente — só voltava a funcionar quando o cooldown
  // expirava sozinho (o que coincidiu com o usuário ter dado hard refresh,
  // mas era só o tempo passando). Fix: fechar manualmente (patchTicket)
  // limpa o cooldown — a próxima mensagem sempre pode reabrir.
  test("reabrir → fechar de novo rápido → reabre de novo sem esperar o cooldown de 60s", async () => {
    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets")
      .send({ userId: "55944@s.whatsapp.net", type: "orcamento" });
    const id = created.body.ticket.id;

    // Fecha e reabre uma primeira vez — isso ativa o cooldown de 60s.
    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    const primeiraReabertura = await ticketService.reopenTicketIfClosed("55944@s.whatsapp.net");
    expect(primeiraReabertura).toBe(true);

    // Atendente fecha de novo, rápido — bem dentro da janela de 60s.
    const fechouDeNovo = await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });
    expect(fechouDeNovo.status).toBe(200);

    // Cliente manda mensagem de novo, imediatamente — sem esperar o
    // cooldown expirar. Antes do fix, isso retornava false silenciosamente.
    const segundaReabertura = await ticketService.reopenTicketIfClosed("55944@s.whatsapp.net");
    expect(segundaReabertura).toBe(true);
  });

  // BUG CORRIGIDO: reopenTicketIfClosed(userId) buscava só por userId EXATO
  // (findByUserId). O WhatsApp entrega mensagens do mesmo cliente ora como
  // "...@lid" ora já resolvidas para "...@s.whatsapp.net" (ver LID_FALLBACK
  // em src/config/whatsapp.js) — se o ticket fechado do cliente estava salvo
  // num formato e a mensagem NOVA chegou resolvida no outro, esta função
  // não achava nada e retornava false, fazendo o fluxo seguinte (main.flow)
  // criar um ticket NOVO duplicado em vez de reabrir o existente.
  test("reopenTicketIfClosed reabre o ticket certo mesmo quando a mensagem nova chega resolvida em outro formato (lid vs jid)", async () => {
    const { setLidMapping } = require("../src/whatsapp/lid-map");
    const lid = "999111222333444@lid";
    const jid = "5511977776666@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    const app = buildApp(ADMIN);
    const created = await request(app).post("/api/tickets").send({ userId: lid, type: "orcamento" });
    const id = created.body.ticket.id;
    await request(app).patch(`/api/tickets/${id}`).send({ status: "resolvido" });

    // Mensagem nova do MESMO cliente chega já resolvida para o JID.
    const reabriu = await ticketService.reopenTicketIfClosed(jid);
    expect(reabriu).toBe(true);

    const atual = await request(app).get("/api/tickets");
    const ticketNoBanco = atual.body.tickets.find(t => t.id === id);
    expect(ticketNoBanco.status).toBe("aberto");
  });
});
