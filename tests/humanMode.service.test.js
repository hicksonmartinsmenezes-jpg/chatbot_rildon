/**
 * Testes de humanMode.service.js — foco no fix do gap lid/jid (ver nota em
 * src/services/humanMode.service.js): o WhatsApp entrega mensagens do mesmo
 * cliente ora como "...@lid" ora já resolvidas para "...@s.whatsapp.net"
 * (LID_FALLBACK em src/config/whatsapp.js). Antes do fix, o módulo indexava
 * sessões de atendimento humano pelo userId cru — um atendente assumindo
 * sob um formato e a próxima mensagem do cliente chegando resolvida no
 * outro fazia estaAtivo() não achar a sessão (bot respondia por engano) ou
 * ativar() criar uma segunda sessão duplicada pro mesmo cliente.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));

const humanMode = require("../src/services/humanMode.service");
const { setLidMapping } = require("../src/whatsapp/lid-map");

describe("humanMode.service — equivalência lid/jid", () => {
  test("estaAtivo() encontra a sessão mesmo consultando pelo outro formato de identificador", () => {
    const lid = "100200300400500@lid";
    const jid = "5511911112222@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    humanMode.ativar(lid, { agentName: "Ana" });

    expect(humanMode.estaAtivo(lid)).toBe(true);
    expect(humanMode.estaAtivo(jid)).toBe(true);

    humanMode.desativar(lid, "teste");
  });

  test("ativar() com o outro formato renova a sessão existente em vez de duplicar", () => {
    const lid = "200300400500600@lid";
    const jid = "5511922223333@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    humanMode.ativar(lid, { agentName: "Bruno" });
    const antes = humanMode.listar().length;

    humanMode.ativar(jid, { agentName: "Bruno" });
    const depois = humanMode.listar().length;

    expect(depois).toBe(antes);

    humanMode.desativar(jid, "teste");
  });

  test("desativar() com o outro formato remove a sessão certa (bot volta a responder)", () => {
    const lid = "300400500600700@lid";
    const jid = "5511933334444@s.whatsapp.net";
    setLidMapping(lid, jid, "test");

    humanMode.ativar(lid, { agentName: "Carla" });
    expect(humanMode.estaAtivo(lid)).toBe(true);

    humanMode.desativar(jid, "teste");

    expect(humanMode.estaAtivo(lid)).toBe(false);
    expect(humanMode.estaAtivo(jid)).toBe(false);
  });

  test("sem nenhum mapeamento lid/jid, continua funcionando normalmente (comportamento antigo preservado)", () => {
    const userId = "5511944445555@s.whatsapp.net";

    expect(humanMode.estaAtivo(userId)).toBe(false);

    humanMode.ativar(userId, { agentName: "Duda" });
    expect(humanMode.estaAtivo(userId)).toBe(true);

    humanMode.desativar(userId, "teste");
    expect(humanMode.estaAtivo(userId)).toBe(false);
  });
});
