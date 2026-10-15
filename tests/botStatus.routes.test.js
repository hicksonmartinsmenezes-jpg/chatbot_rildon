/**
 * Testes de botStatus.routes.js.
 *
 * Feature pedida pelo usuário (2026-07-24): "adicione painel de bot para
 * todos" — qualquer atendente logado (não só admin) deve poder ligar/
 * desligar o bot. Ao contrário de settings.routes.js (admin-only, expõe
 * TODA a Central de Configurações), esta rota só lê/grava bot.ativo.
 *
 * Mocka a fronteira com settings.service, activityLog.service e
 * socket.service — o handler em si (validação + orquestração) roda de
 * verdade, mesmo padrão de user.routes.test.js.
 */
jest.mock("../src/services/settings.service", () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn()
}));
jest.mock("../src/services/activityLog.service", () => ({
  addLog: jest.fn().mockResolvedValue(undefined)
}));
jest.mock("../src/services/socket.service", () => ({
  emitEvent: jest.fn()
}));

const express = require("express");
const request = require("supertest");

const { getSettings, saveSettings } = require("../src/services/settings.service");
const { addLog } = require("../src/services/activityLog.service");
const { emitEvent } = require("../src/services/socket.service");
const botStatusRoutes = require("../src/routes/botStatus.routes");

function buildApp(user = { id: "u1", nome: "Atendente Teste", perfil: "atendente" }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; next(); });
  app.use("/api", botStatusRoutes);
  return app;
}

describe("GET /api/bot-status", () => {
  beforeEach(() => jest.clearAllMocks());

  test("retorna ativo:true quando bot.ativo é true", async () => {
    getSettings.mockResolvedValue({ bot: { ativo: true } });
    const res = await request(buildApp()).get("/api/bot-status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativo: true });
  });

  test("retorna ativo:false quando bot.ativo é false", async () => {
    getSettings.mockResolvedValue({ bot: { ativo: false } });
    const res = await request(buildApp()).get("/api/bot-status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativo: false });
  });

  test("qualquer perfil (não só admin) consegue ler — não há checagem de perfil no handler", async () => {
    getSettings.mockResolvedValue({ bot: { ativo: true } });
    const res = await request(buildApp({ id: "u2", nome: "Atendente X", perfil: "atendente" }))
      .get("/api/bot-status");
    expect(res.status).toBe(200);
  });
});

describe("PUT /api/bot-status", () => {
  beforeEach(() => jest.clearAllMocks());

  test("liga o bot: salva, audita e emite socket", async () => {
    saveSettings.mockResolvedValue({ bot: { ativo: true } });
    const user = { id: "u1", nome: "Atendente Teste", perfil: "atendente" };

    const res = await request(buildApp(user))
      .put("/api/bot-status")
      .send({ ativo: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativo: true });
    expect(saveSettings).toHaveBeenCalledWith({ bot: { ativo: true } });
    expect(addLog).toHaveBeenCalledWith(user, "BOT_LIGADO", expect.stringContaining("ativou"));
    expect(emitEvent).toHaveBeenCalledWith("bot_status_atualizado", { ativo: true, por: user.nome });
  });

  test("desliga o bot: salva, audita e emite socket", async () => {
    saveSettings.mockResolvedValue({ bot: { ativo: false } });
    const user = { id: "u1", nome: "Atendente Teste", perfil: "atendente" };

    const res = await request(buildApp(user))
      .put("/api/bot-status")
      .send({ ativo: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativo: false });
    expect(addLog).toHaveBeenCalledWith(user, "BOT_DESLIGADO", expect.stringContaining("desativou"));
    expect(emitEvent).toHaveBeenCalledWith("bot_status_atualizado", { ativo: false, por: user.nome });
  });

  test("rejeita corpo sem 'ativo' booleano (400) e não salva nada", async () => {
    const res = await request(buildApp()).put("/api/bot-status").send({ ativo: "true" });
    expect(res.status).toBe(400);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  test("rejeita corpo vazio (400)", async () => {
    const res = await request(buildApp()).put("/api/bot-status").send({});
    expect(res.status).toBe(400);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
