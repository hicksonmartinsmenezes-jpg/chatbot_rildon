const express = require("express");
const request = require("supertest");

describe("rotas internas (painel <-> catálogo)", () => {
  const TOKEN = "t".repeat(40);
  let app;
  beforeAll(() => {
    process.env.API_TOKEN = TOKEN;
    delete process.env.INTERNO_TOKEN;
    app = express();
    app.use(express.json());
    app.use("/api", require("../src/routes/interno.routes"));
  });

  test("sem token: 403", async () => {
    const r = await request(app).post("/api/interno/recarregar").send({ tipo: "fotos" });
    expect(r.status).toBe(403);
  });

  test("token errado: 403", async () => {
    const r = await request(app).post("/api/interno/recarregar").set("X-Interno-Token", "x".repeat(40)).send({ tipo: "fotos" });
    expect(r.status).toBe(403);
  });

  test("tipo inválido com token certo: 400", async () => {
    const r = await request(app).post("/api/interno/recarregar").set("X-Interno-Token", TOKEN).send({ tipo: "qualquer" });
    expect(r.status).toBe(400);
  });

  test("fotos com token certo: recarrega o cache", async () => {
    const r = await request(app).post("/api/interno/recarregar").set("X-Interno-Token", TOKEN).send({ tipo: "fotos" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, tipo: "fotos" });
  });
});

describe("espelho.service", () => {
  test("avisar não lança e é no-op em teste", () => {
    const { avisar, urlDoOutro } = require("../src/services/espelho.service");
    expect(() => avisar("fotos")).not.toThrow();
    delete process.env.CATALOGO_PROCESSO;
    expect(urlDoOutro()).toBe("http://catalogo:3001");
    process.env.CATALOGO_PROCESSO = "catalogo";
    expect(urlDoOutro()).toBe("http://app:3000");
    delete process.env.CATALOGO_PROCESSO;
  });
});

// O describe "catalogo-app" (testava src/catalogo-app.js) saiu daqui em
// 2026-11-03 — esse processo agora é o repositório catalogo-rildon, com
// sua própria suíte de testes.
