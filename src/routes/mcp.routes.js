const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { criarServidorMcp } = require("../services/mcp.service");
const { mcpLimiter } = require("../middlewares/rate-limiters");
const logger = require("../utils/logger");

// POST /api/mcp — servidor MCP somente-leitura (nova função, pedido do
// usuário 2026-09-09 — ver comentário completo em mcp.service.js).
//
// Desligado por padrão (MCP_ENABLED, mesmo padrão opt-in do OpenWA que
// inspirou a ideia) — ninguém precisa pensar nisso pra rodar o bot Rildon
// normalmente, só quem for de propósito plugar um Claude Code/Desktop local
// nele.
//
// Autenticação (revisado 2026-09-09 — pedido do usuário depois de olhar
// como o próprio OpenWA trata chave de agente de IA: nunca reaproveitar
// credencial de admin, sempre uma chave própria e escopada): NÃO usa mais o
// authSession genérico (removido de app.js pra esta rota). authSession
// aceita tanto sessão de atendente quanto `Authorization: Bearer
// <API_TOKEN>` — o MESMO token que os scripts do X2 usam e que, por
// authSession, também autoriza rotas que ENVIAM mensagem e mexem em ticket
// (message.routes.js, ticket.routes.js etc). As tools do MCP são só
// leitura; autenticar com essa credencial ampla anularia essa garantia se o
// token vazasse (ele fica salvo no `.mcp.json` da máquina do usuário — um
// alvo mais exposto que o `.env` do servidor). Por isso esta rota valida
// direto contra um token PRÓPRIO, `MCP_API_TOKEN`, que nenhuma outra rota
// reconhece — vazar ele não dá acesso a nada além do que as 6 tools
// somente-leitura já expõem.
function safeCompare(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function autenticarMcp(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const mcpToken = process.env.MCP_API_TOKEN;

  const tokenValido =
    provided &&
    mcpToken &&
    mcpToken !== "troque_por_um_token_com_64_caracteres_ou_mais" &&
    safeCompare(provided, mcpToken);

  if (!tokenValido) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  return next();
}

// Gate MCP_ENABLED roda ANTES da autenticação de propósito: com o MCP
// desligado, a rota responde 404 pra qualquer um, sem dar pista nenhuma
// (nem "401 não autorizado") de que existe algo ali pra tentar autenticar.
function gateMcpEnabled(req, res, next) {
  if (String(process.env.MCP_ENABLED || "").toLowerCase() !== "true") {
    return res.status(404).json({ error: "MCP desativado (MCP_ENABLED=false)." });
  }
  return next();
}

// Modo "stateless": cria um McpServer + transport NOVOS a cada requisição
// (sessionIdGenerator: undefined), em vez de manter sessão MCP viva entre
// chamadas. Mais simples de operar (sem estado pra vazar entre processos,
// sem limpeza de sessão expirada) e adequado aqui — as tools são todas
// leituras baratas (uma query cada), não há streaming nem long-running task
// que justifique sessão persistente. Documentado como um dos dois modos
// oficiais do SDK pra transporte HTTP.
//
// Rate limit: mcpLimiter (MCP_RATE_LIMIT_MAX no .env) roda DEPOIS da
// autenticação e é dedicado a esta rota — separado do apiLimiter geral do
// painel (que também se aplica aqui, por ser global em app.js). Justifica-se
// porque uma única pergunta em linguagem natural pro Claude local pode virar
// várias tool calls em sequência rápida — ver comentário em
// src/middlewares/rate-limiters.js.
router.post("/mcp", gateMcpEnabled, autenticarMcp, mcpLimiter, async (req, res) => {
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
