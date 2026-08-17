/**
 * Testes de broadcast.service.js.
 *
 * Foco especial em createBroadcast (insert em lote dos destinatários,
 * introduzido para evitar um INSERT por linha em campanhas grandes — ver
 * commit "Otimiza queries de tickets, respostas rápidas e broadcast") e nas
 * transições de status de uma campanha (pending → sending → finished/
 * cancelled), que já tiveram bug real de race condition no passado (por
 * isso o UPDATE atômico com WHERE status = 'pending').
 *
 * config/whatsapp é mockado inteiramente — não queremos rede real nem os
 * sleeps de 5s por destinatário no envio.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../src/config/whatsapp", () => ({
  sendMessage: jest.fn().mockResolvedValue(undefined),
  sendMedia: jest.fn().mockResolvedValue(undefined),
  resolveLid: jest.fn().mockReturnValue(null)
}));

const pool = require("../src/database/postgres");
const whatsapp = require("../src/config/whatsapp");
const broadcastService = require("../src/services/broadcast.service");

let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function buildState() {
  return { broadcasts: [], recipients: [], clients: [] };
}

function findBroadcast(state, id) {
  return state.broadcasts.find(b => b.id === id);
}

function makeFakeClient(state) {
  const client = {
    query: jest.fn(async (text, params = []) => dispatch(state, text, params)),
    release: jest.fn()
  };
  state.clients.push(client);
  return client;
}

function dispatch(state, text, params = []) {
  const sql = String(text).replace(/\s+/g, " ").trim();

  if (/^BEGIN$/.test(sql) || /^COMMIT$/.test(sql) || /^ROLLBACK$/.test(sql)) {
    return { rows: [], rowCount: 0 };
  }

  if (/^INSERT INTO broadcasts/.test(sql)) {
    const row = {
      id: nextId("b"),
      title: params[0],
      message: params[1],
      total_recipients: params[2],
      created_by: params[3],
      image_url: params[4],
      media_type: params[5],
      status: "pending",
      sent_count: 0,
      failed_count: 0,
      started_at: null,
      finished_at: null,
      created_at: new Date()
    };
    state.broadcasts.push(row);
    return { rows: [row] };
  }

  if (/^INSERT INTO broadcast_recipients/.test(sql)) {
    const inserted = [];
    for (let i = 0; i < params.length; i += 3) {
      const row = {
        id: nextId("r"),
        broadcast_id: params[i],
        user_id: params[i + 1],
        contact_name: params[i + 2],
        status: "pending",
        sent_at: null,
        error: null
      };
      state.recipients.push(row);
      inserted.push(row);
    }
    return { rows: inserted, rowCount: inserted.length };
  }

  if (/^SELECT \* FROM broadcasts ORDER BY created_at DESC LIMIT \$1 OFFSET \$2/.test(sql)) {
    const [limit, offset] = params;
    return { rows: state.broadcasts.slice(offset, offset + limit) };
  }

  if (/^SELECT \* FROM broadcast_recipients WHERE broadcast_id = \$1 ORDER BY id ASC/.test(sql)) {
    return { rows: state.recipients.filter(r => r.broadcast_id === params[0]) };
  }

  if (/^UPDATE broadcasts SET status = 'sending', started_at = NOW\(\)/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    if (!b || b.status !== "pending") return { rows: [], rowCount: 0 };
    b.status = "sending";
    b.started_at = new Date();
    return { rows: [b], rowCount: 1 };
  }

  if (/^SELECT status FROM broadcasts WHERE id = \$1/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    return { rows: b ? [{ status: b.status }] : [] };
  }

  if (/^UPDATE broadcasts\s+SET status = 'cancelled'/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    if (!b || !["pending", "sending"].includes(b.status)) return { rows: [], rowCount: 0 };
    b.status = "cancelled";
    b.finished_at = new Date();
    return { rows: [{ id: b.id }], rowCount: 1 };
  }

  if (/^SELECT \* FROM broadcasts WHERE id = \$1/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    return { rows: b ? [b] : [] };
  }

  if (/^UPDATE broadcast_recipients SET status = 'sent'/.test(sql)) {
    const r = state.recipients.find(x => x.id === params[0]);
    if (r) { r.status = "sent"; r.sent_at = new Date(); r.error = null; }
    return { rows: [], rowCount: r ? 1 : 0 };
  }

  if (/^UPDATE broadcast_recipients SET status = 'failed'/.test(sql)) {
    const r = state.recipients.find(x => x.id === params[1]);
    if (r) { r.status = "failed"; r.error = params[0]; }
    return { rows: [], rowCount: r ? 1 : 0 };
  }

  if (/^UPDATE broadcasts SET sent_count = \$1, failed_count = \$2 WHERE id = \$3/.test(sql)) {
    const b = findBroadcast(state, params[2]);
    if (b) { b.sent_count = params[0]; b.failed_count = params[1]; }
    return { rows: [], rowCount: b ? 1 : 0 };
  }

  if (/^UPDATE broadcasts\s+SET status = 'finished'/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    if (b) { b.status = "finished"; b.finished_at = new Date(); }
    return { rows: [], rowCount: b ? 1 : 0 };
  }

  if (/^DELETE FROM broadcasts WHERE id = \$1 AND status <> 'sending'/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    if (!b || b.status === "sending") return { rows: [], rowCount: 0 };
    state.broadcasts = state.broadcasts.filter(x => x.id !== b.id);
    return { rows: [{ id: b.id }], rowCount: 1 };
  }

  if (/^SELECT COUNT\(\*\) FROM broadcast_recipients WHERE broadcast_id = \$1 AND status = 'failed'/.test(sql)) {
    const count = state.recipients.filter(r => r.broadcast_id === params[0] && r.status === "failed").length;
    return { rows: [{ count: String(count) }] };
  }

  if (/^UPDATE broadcast_recipients SET status = 'pending', error = NULL, sent_at = NULL/.test(sql)) {
    state.recipients
      .filter(r => r.broadcast_id === params[0] && r.status === "failed")
      .forEach(r => { r.status = "pending"; r.error = null; r.sent_at = null; });
    return { rows: [], rowCount: 0 };
  }

  if (/^SELECT COUNT\(\*\) FROM broadcast_recipients WHERE broadcast_id = \$1\s*$/.test(sql)) {
    const count = state.recipients.filter(r => r.broadcast_id === params[0]).length;
    return { rows: [{ count: String(count) }] };
  }

  if (/^UPDATE broadcasts\s+SET status = 'sending', started_at = NOW\(\),\s*total_recipients/.test(sql)) {
    const b = findBroadcast(state, params[0]);
    if (b) { b.status = "sending"; b.total_recipients = params[1]; b.failed_count = 0; }
    return { rows: [], rowCount: b ? 1 : 0 };
  }

  if (/^SELECT\s+COUNT\(\*\)::int AS campaigns/.test(sql)) {
    const campaigns = state.broadcasts.length;
    const sent = state.broadcasts.reduce((s, b) => s + (b.sent_count || 0), 0);
    const failed = state.broadcasts.reduce((s, b) => s + (b.failed_count || 0), 0);
    const total_recipients = state.broadcasts.reduce((s, b) => s + (b.total_recipients || 0), 0);
    return { rows: [{ campaigns, sent, failed, total_recipients }] };
  }

  if (/FROM history[\s\S]*created_at >= NOW\(\) - INTERVAL '30 days'/.test(sql)) {
    return { rows: [{ user_id: "55998@s.whatsapp.net", contact_name: "Cliente Recente" }] };
  }

  if (/FROM tickets\s+WHERE user_id IS NOT NULL/.test(sql)) {
    return { rows: [{ user_id: "55997@s.whatsapp.net", contact_name: "Cliente Com Ticket" }] };
  }

  // BUG CORRIGIDO (Issue #7, 2026-08-17): "all_clients" e "contacts" (sem tag/
  // atendente) viram a MESMA query textual desde 2026-08-05 ("all_clients"
  // migrou de history para contacts direto, ver getBroadcastAudience em
  // broadcast.service.js) — o mock antigo tinha um branch morto pra
  // "FROM history WHERE ... GROUP BY user_id" (sem filtro de data) que
  // nenhuma query real dispara mais, então "all_clients" caía sem querer
  // neste branch de "contacts" só por coincidência de regex, retornando um
  // userId de formato diferente do que o teste antigo esperava. userId RAW
  // (sem @s.whatsapp.net) é o formato real de contacts.whatsapp — vira JID
  // completo só depois, em createBroadcast()/normalizeUserId().
  if (/FROM contacts\s+WHERE/.test(sql)) {
    return { rows: [{ user_id: "55996", contact_name: "Contato Ativo" }] };
  }

  throw new Error("Query não mapeada no mock de broadcast.service.test.js: " + sql);
}

function installFakePool(state) {
  pool.query.mockImplementation((text, params) => dispatch(state, text, params));
  pool.connect.mockImplementation(async () => makeFakeClient(state));
}

describe("broadcast.service", () => {
  let state;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    state = buildState();
    installFakePool(state);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("createBroadcast", () => {
    test("título ou mensagem ausente → lança erro", async () => {
      await expect(broadcastService.createBroadcast({ title: "", message: "m", recipients: [{ userId: "1" }] }))
        .rejects.toThrow(/obrigatórios/);
    });

    test("sem destinatários → lança erro", async () => {
      await expect(broadcastService.createBroadcast({ title: "t", message: "m", recipients: [] }))
        .rejects.toThrow(/destinatário/);
    });

    test("normaliza e deduplica destinatários repetidos", async () => {
      const broadcast = await broadcastService.createBroadcast({
        title: "Promoção",
        message: "Oferta imperdível",
        recipients: [
          { userId: "79999999999" },
          { userId: "79999999999" }, // duplicado
          { numero: "79988888888", nome: "Cliente B" }
        ]
      });

      expect(broadcast.total_recipients).toBe(2);
      expect(state.recipients).toHaveLength(2);
      expect(state.recipients.map(r => r.user_id)).toEqual(
        expect.arrayContaining(["79999999999@s.whatsapp.net", "79988888888@s.whatsapp.net"])
      );
    });

    // BUG CORRIGIDO: getBroadcastAudience (GROUP BY user_id em history/
    // tickets) pode trazer o MESMO cliente real duas vezes se ele tem
    // linhas salvas em formatos diferentes de identificador — o WhatsApp
    // entrega mensagens ora como "...@lid" ora já resolvidas para
    // "...@s.whatsapp.net" (ver LID_FALLBACK em src/config/whatsapp.js).
    // Sem considerar essa equivalência, o dedup de createBroadcast tratava
    // as duas entradas como destinatários diferentes — o cliente recebia a
    // campanha duas vezes.
    test("BUG CORRIGIDO: dedupe considera equivalência lid/jid — mesmo cliente em dois formatos não recebe a campanha duas vezes", async () => {
      const lid = "600700800900100@lid";
      const jid = "5511988889999@s.whatsapp.net";
      whatsapp.resolveLid.mockImplementation(v => (v === lid ? jid : null));

      const broadcast = await broadcastService.createBroadcast({
        title: "Promoção",
        message: "Oferta imperdível",
        recipients: [
          { userId: lid, contactName: "Cliente Lid" },
          { userId: jid, contactName: "Cliente Jid" }
        ]
      });

      expect(broadcast.total_recipients).toBe(1);
      expect(state.recipients).toHaveLength(1);

      whatsapp.resolveLid.mockReturnValue(null); // restaura o default pros testes seguintes
    });

    test("insere destinatários em mais de um lote quando excede o tamanho do chunk", async () => {
      const recipients = Array.from({ length: 501 }, (_, i) => ({ userId: `7900000${String(i).padStart(4, "0")}` }));

      const broadcast = await broadcastService.createBroadcast({
        title: "Campanha grande",
        message: "Olá!",
        recipients
      });

      expect(broadcast.total_recipients).toBe(501);
      expect(state.recipients).toHaveLength(501);

      const client = state.clients[state.clients.length - 1];
      const insertCalls = client.query.mock.calls.filter(([sql]) => /^\s*INSERT INTO broadcast_recipients/.test(sql));
      expect(insertCalls).toHaveLength(2); // 500 + 1
    });
  });

  describe("listBroadcasts", () => {
    test("aplica paginação (limit/offset) corretamente", async () => {
      await broadcastService.createBroadcast({ title: "A", message: "m", recipients: [{ userId: "1" }] });
      await broadcastService.createBroadcast({ title: "B", message: "m", recipients: [{ userId: "2" }] });

      const page1 = await broadcastService.listBroadcasts({ page: 1, limit: 1 });
      expect(page1).toHaveLength(1);
    });
  });

  describe("startBroadcast", () => {
    test("transmissão pendente inicia com sucesso", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      const result = await broadcastService.startBroadcast(b.id);
      expect(result.ok).toBe(true);
      await jest.runAllTimersAsync(); // drena o processBroadcastQueue em background antes do teste terminar
    });

    test("transmissão inexistente → erro", async () => {
      await expect(broadcastService.startBroadcast("id-fantasma")).rejects.toThrow(/não encontrada/);
    });

    test("transmissão já em andamento → mensagem específica", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      await broadcastService.startBroadcast(b.id); // pending → sending

      await expect(broadcastService.startBroadcast(b.id)).rejects.toThrow(/já está em andamento/);
      await jest.runAllTimersAsync();
    });

    test("transmissão já finalizada → mensagem específica", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      findBroadcast(state, b.id).status = "finished";

      await expect(broadcastService.startBroadcast(b.id)).rejects.toThrow(/já foi finalizada/);
    });
  });

  describe("cancelBroadcast", () => {
    test("cancela transmissão pendente", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      const result = await broadcastService.cancelBroadcast(b.id);
      expect(result.ok).toBe(true);
      expect(findBroadcast(state, b.id).status).toBe("cancelled");
    });

    test("transmissão inexistente ou já finalizada → erro", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      findBroadcast(state, b.id).status = "finished";

      await expect(broadcastService.cancelBroadcast(b.id)).rejects.toThrow(/não encontrada ou não pode ser cancelada/);
    });
  });

  describe("deleteBroadcast", () => {
    test("exclui campanha que não está enviando", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      const result = await broadcastService.deleteBroadcast(b.id);
      expect(result.ok).toBe(true);
      expect(findBroadcast(state, b.id)).toBeUndefined();
    });

    test("não permite excluir campanha em envio", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      findBroadcast(state, b.id).status = "sending";

      await expect(broadcastService.deleteBroadcast(b.id)).rejects.toThrow(/em envio/);
    });
  });

  describe("getBroadcastStats", () => {
    test("calcula successRate com base em sent/failed acumulados", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      findBroadcast(state, b.id).sent_count = 3;
      findBroadcast(state, b.id).failed_count = 1;

      const stats = await broadcastService.getBroadcastStats();
      expect(stats.campaigns).toBe(1);
      expect(stats.sent).toBe(3);
      expect(stats.failed).toBe(1);
      expect(stats.successRate).toBe(75);
    });

    test("sem tentativas ainda: successRate é 0, não NaN", async () => {
      await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      const stats = await broadcastService.getBroadcastStats();
      expect(stats.successRate).toBe(0);
    });
  });

  describe("getBroadcastAudience", () => {
    test("tipo inválido lança erro", async () => {
      await expect(broadcastService.getBroadcastAudience("tipo-invalido")).rejects.toThrow(/inválido/);
    });

    // BUG CORRIGIDO (Issue #7, 2026-08-17): este teste ainda esperava o
    // comportamento pré-2026-08-03, quando "all_clients" buscava em
    // `history`. Desde então (pedido do usuário: contatos importados via
    // bulk-tag-contacts.js nunca mandaram mensagem, ficavam de fora),
    // "all_clients" busca direto em `contacts` — mesma fonte/formato de
    // userId que o tipo "contacts" (RAW, sem "@s.whatsapp.net"; normalizado
    // depois em createBroadcast()/normalizeUserId()). Título e asserção
    // atualizados pra refletir a query real de hoje.
    test("all_clients retorna contatos vindos de contacts (não mais de history, ver 2026-08-03)", async () => {
      const audience = await broadcastService.getBroadcastAudience("all_clients");
      expect(audience[0]).toMatchObject({ userId: "55996" });
    });

    test("with_tickets retorna contatos vindos de tickets", async () => {
      const audience = await broadcastService.getBroadcastAudience("with_tickets");
      expect(audience[0]).toMatchObject({ userId: "55997@s.whatsapp.net" });
    });

    test("last_30_days aplica filtro de data", async () => {
      const audience = await broadcastService.getBroadcastAudience("last_30_days");
      expect(audience[0]).toMatchObject({ userId: "55998@s.whatsapp.net" });
    });

    test("contacts com filtro de tag e atendente monta WHERE parametrizado", async () => {
      const audience = await broadcastService.getBroadcastAudience("contacts", { tag: "vip", atendenteId: "u1" });
      expect(audience[0]).toMatchObject({ userId: "55996" });
    });

    // Pedido do usuário: campanha combinando "Funcionário(a)" + "Diretor
    // Geral" ao mesmo tempo — antes só existia `tag` singular, e combinar
    // mais de uma etiqueta exigia buscar cada uma separado e deduplicar na
    // mão (foi assim que a campanha de teste real precisou ser montada).
    // Agora `tags` (array) monta uma única query com overlap (&&), que já
    // resolve tanto o "OR" entre etiquetas quanto evita duplicar linhas por
    // contato — sem precisar de dedup client-side.
    test("contacts com tags (array) monta cláusula de overlap, não uma tag só", async () => {
      await broadcastService.getBroadcastAudience("contacts", { tags: ["Funcionário(a)", "Diretor Geral"] });

      const call = pool.query.mock.calls.find(([sql]) => /FROM contacts/.test(sql));
      expect(call[0]).toMatch(/tags && \$1::text\[\]/);
      expect(call[1]).toEqual([["Funcionário(a)", "Diretor Geral"]]);
    });

    test("contacts sem nenhuma tag selecionada não filtra por etiqueta (todas)", async () => {
      await broadcastService.getBroadcastAudience("contacts", { tags: [] });

      const call = pool.query.mock.calls.find(([sql]) => /FROM contacts/.test(sql));
      expect(call[0]).not.toMatch(/tags &&/);
    });

    test("contacts com tag singular E tags juntos combina sem duplicar", async () => {
      await broadcastService.getBroadcastAudience("contacts", { tag: "vip", tags: ["vip", "Diretor Geral"] });

      const call = pool.query.mock.calls.find(([sql]) => /FROM contacts/.test(sql));
      expect(call[1][0].sort()).toEqual(["Diretor Geral", "vip"]);
    });
  });

  describe("retryFailedRecipients", () => {
    test("sem destinatários com falha → erro", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      await expect(broadcastService.retryFailedRecipients(b.id)).rejects.toThrow(/Nenhum destinatário com falha/);
    });

    test("reseta destinatários com falha para pending e reinicia a campanha", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "1" }] });
      state.recipients.find(r => r.broadcast_id === b.id).status = "failed";

      const result = await broadcastService.retryFailedRecipients(b.id);
      expect(result.ok).toBe(true);
      expect(state.recipients.find(r => r.broadcast_id === b.id).status).toBe("pending");
      expect(findBroadcast(state, b.id).status).toBe("sending");
      await jest.runAllTimersAsync();
    });
  });

  describe("fluxo de envio (processBroadcastQueue, via startBroadcast)", () => {
    test("chama sendMessage, marca como enviado e finaliza a campanha", async () => {
      const b = await broadcastService.createBroadcast({ title: "T", message: "m", recipients: [{ userId: "79999999999" }] });

      await broadcastService.startBroadcast(b.id);
      // processBroadcastQueue roda em background (fire-and-forget); fake timers
      // deixam o sleep(5000) entre destinatários resolver instantaneamente.
      await jest.runAllTimersAsync();

      expect(whatsapp.sendMessage).toHaveBeenCalledWith("79999999999@s.whatsapp.net", "m");
      expect(state.recipients.find(r => r.broadcast_id === b.id).status).toBe("sent");
      expect(findBroadcast(state, b.id).status).toBe("finished");
    });
  });
});
