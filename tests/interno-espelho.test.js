const express = require("express");
const request = require("supertest");

// Carregar o app do catálogo puxa os serviços de PDF/fotos (pesados): sob carga passa de 5 s.
jest.setTimeout(30000);

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

describe("catalogo-app", () => {
  test("health responde e rota de painel não existe", async () => {
    process.env.API_TOKEN = "t".repeat(40);
    const app = require("../src/catalogo-app");
    const h = await request(app).get("/health");
    expect(h.status).toBe(200);
    expect(h.body.processo).toBe("catalogo");
    const x = await request(app).get("/api/tickets");
    expect([401, 404]).toContain(x.status);
  });
});
