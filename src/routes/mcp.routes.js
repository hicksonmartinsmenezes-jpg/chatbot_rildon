const express = require("express");
const router = express.Router();
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { criarServidorMcp } = require("../services/mcp.service");
const logger = require("../utils/logger");

// POST /api/mcp — servidor MCP somente-leitura (nova função, pedido do
// usuário 2026-09-09 — ver comentário completo em mcp.service.js).
//
// Desligado por padrão (MCP_ENABLED, mesmo padrão opt-in do OpenWA que
// inspirou a ideia) — ninguém precisa pensar nisso pra rodar o bot Rildon
// normalmente, só quem for de propósito plugar um Claude Code/Desktop local
// nele.
//
// Autenticação: reaproveita authSession (aplicado em app.js,
// `app.use("/api", authSession, mcpRoutes)`) — aceita tanto sessão de
// atendente logado quanto `Authorization: Bearer <API_TOKEN>`, o MESMO
// esquema que os scripts do X2 já usam (ver comentário em
// recarregarEstoqueHandler/catalogo.controller.js). Um cliente MCP local
// configura só o header Bearer com o API_TOKEN do .env — não precisa de
// usuário/senha nem 2FA.
//
// Modo "stateless": cria um McpServer + transport NOVOS a cada requisição
// (sessionIdGenerator: undefined), em vez de manter sessão MCP viva entre
// chamadas. Mais simples de operar (sem estado pra vazar entre processos,
// sem limpeza de sessão expirada) e adequado aqui — as tools são todas
// leituras baratas (uma query cada), não há streaming nem long-running task
// que justifique sessão persistente. Documentado como um dos dois modos
// oficiais do SDK pra transporte HTTP.
router.post("/mcp", async (req, res) => {
  if (String(process.env.MCP_ENABLED || "").toLowerCase() !== "true") {
    return res.status(404).json({ error: "MCP desativado (MCP_ENABLED=false)." });
  }

  try {
    const server = criarServidorMcp();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error(`[MCP] Erro ao processar requisição: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erro interno no servidor MCP." });
    }
  }
});

module.exports = router;
