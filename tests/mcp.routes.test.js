/**
 * Testes de mcp.routes.js — cobertura DELIBERADAMENTE limitada ao que dá pra
 * verificar sem depender do protocolo MCP de verdade (handshake JSON-RPC via
 * StreamableHTTPServerTransport, biblioteca @modelcontextprotocol/sdk).
 *
 * O que este arquivo cobre: o gate MCP_ENABLED (rota precisa responder 404
 * quando desligada — comportamento padrão — e só tentar montar o servidor
 * MCP quando ligada) e a autenticação por MCP_API_TOKEN (token PRÓPRIO,
 * dedicado — ver comentário em mcp.routes.js sobre por que não reaproveita
 * mais o API_TOKEN geral).
 *
 * O que este arquivo NÃO cobre (limitação do sandbox do agente, documentada
 * no PR): o handshake real do protocolo MCP (initialize/tools list/tools
 * call) e o comportamento de cada tool registrada em mcp.service.js. O
 * sandbox onde este teste foi escrito não tem `npm install` funcional
 * (@modelcontextprotocol/sdk nunca foi instalado de verdade aqui — ver
 * feedback-npm-install-onedrive-folder-race na memória do agente), então
 * não dá pra validar a API do SDK/transport com confiança sem rodar de
 * verdade. Precisa de um teste de integração real (ou ao menos rodar
 * localmente com um cliente MCP de verdade) antes de considerar essa parte
 * validada — ver "Como foi validado" no PR.
 *
 * mcp.routes.js -> mcp.service.js -> config/whatsapp.js -> @whiskeysockets/
 * baileys, cujo build publicado usa `import` no topo do arquivo (ESM puro) —
 * o Jest, com node_modules fora do transform por padrão, quebra ao tentar
 * fazer parse disso ("Cannot use import statement outside a module") assim
 * que qualquer coisa REQUIRE essa cadeia sem mockar antes. Mesmo problema,
 * mesma solução já usada em whatsapp.config.test.js: mocka baileys (e o que
 * config/whatsapp.js toca no import de topo) ANTES do primeiro require de
 * mcp.routes.js. Não precisa de comportamento real aqui — os testes abaixo
 * nunca chegam a chamar criarServidorMcp().
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("qrcode-terminal", () => ({ generate: jest.fn() }));
jest.mock("@whiskeysockets/baileys", () => ({
  __esModule: true,
  default: jest.fn(),
  useMultiFileAuthState: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0] })
}));

const express = require("express");
const request = require("supertest");

const mcpRoutes = require("../src/routes/mcp.routes");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: "u1", perfil: "atendente" }; next(); });
  app.use("/api", mcpRoutes);
  return app;
}

describe("POST /api/mcp — gate MCP_ENABLED", () => {
  const originalEnv = process.env.MCP_ENABLED;
  afterEach(() => { process.env.MCP_ENABLED = originalEnv; });

  test("MCP_ENABLED ausente → 404, sem tentar montar o servidor MCP", async () => {
    delete process.env.MCP_ENABLED;
    const res = await request(buildApp()).post("/api/mcp").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "MCP desativado (MCP_ENABLED=false)." });
  });

  test("MCP_ENABLED=false (explícito) → 404", async () => {
    process.env.MCP_ENABLED = "false";
    const res = await request(buildApp()).post("/api/mcp").send({});
    expect(res.status).toBe(404);
  });

  test("MCP_ENABLED com valor não-'true' (ex: '1') → 404 — precisa ser exatamente 'true'", async () => {
    process.env.MCP_ENABLED = "1";
    const res = await request(buildApp()).post("/api/mcp").send({});
    expect(res.status).toBe(404);
  });

  // Gate roda ANTES da autenticação de propósito (ver comentário em
  // mcp.routes.js) — desligado, nem token errado muda o 404 pra 401.
  test("MCP_ENABLED=false + sem Authorization nenhum → ainda 404, não 401", async () => {
    process.env.MCP_ENABLED = "false";
    const res = await request(buildApp()).post("/api/mcp").send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /api/mcp — autenticação (MCP_API_TOKEN dedicado)", () => {
  const originalEnabled = process.env.MCP_ENABLED;
  const originalToken = process.env.MCP_API_TOKEN;
  const TOKEN_TESTE = "token-mcp-de-teste-0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    process.env.MCP_ENABLED = "true";
    process.env.MCP_API_TOKEN = TOKEN_TESTE;
  });

  afterEach(() => {
    process.env.MCP_ENABLED = originalEnabled;
    process.env.MCP_API_TOKEN = originalToken;
  });

  test("sem header Authorization → 401", async () => {
    const res = await request(buildApp()).post("/api/mcp").send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Não autorizado." });
  });

  test("Bearer com token errado → 401", async () => {
    const res = await request(buildApp())
      .post("/api/mcp")
      .set("Authorization", "Bearer token-completamente-errado")
      .send({});
    expect(res.status).toBe(401);
  });

  test("Bearer com o API_TOKEN geral (não o MCP_API_TOKEN) → 401 — não reaproveita mais a credencial geral", async () => {
    const res = await request(buildApp())
      .post("/api/mcp")
      .set("Authorization", "Bearer troque_por_um_token_com_64_caracteres_ou_mais")
      .send({});
    expect(res.status).toBe(401);
  });

  test("MCP_API_TOKEN não configurado (placeholder do .env.example) → 401 mesmo com Bearer igual ao placeholder", async () => {
    process.env.MCP_API_TOKEN = "troque_por_um_token_com_64_caracteres_ou_mais";
    const res = await request(buildApp())
      .post("/api/mcp")
      .set("Authorization", "Bearer troque_por_um_token_com_64_caracteres_ou_mais")
      .send({});
    expect(res.status).toBe(401);
  });

  test("Bearer com MCP_API_TOKEN correto → passa da autenticação (nunca 401/404 — o que vier depois é do SDK, fora do escopo deste arquivo)", async () => {
    const res = await request(buildApp())
      .post("/api/mcp")
      .set("Authorization", `Bearer ${TOKEN_TESTE}`)
      .send({});
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });
});
