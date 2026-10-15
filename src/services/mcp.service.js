/**
 * mcp.service.js — servidor MCP (Model Context Protocol) somente-leitura do
 * bot Rildon.
 *
 * NOVA FUNÇÃO (pedido do usuário, 2026-09-09): depois de olhar o projeto
 * OpenWA (gateway genérico de WhatsApp que expõe um servidor MCP pra
 * clientes de IA operarem sessões), o usuário perguntou se valia reaproveitar
 * a ideia aqui. Resposta discutida e confirmada com o usuário: SIM, mas só a
 * ideia — não o código (OpenWA é NestJS multi-tenant, este projeto é Express
 * single-tenant) — e só LEITURA (o usuário escolheu explicitamente
 * "consultar dados", não "também enviar mensagens/ações", quando perguntado).
 *
 * O que isso é: uma sessão de Claude Code/Desktop rodando na MÁQUINA DO
 * USUÁRIO pode apontar pra http://localhost:PORT/api/mcp (ver
 * routes/mcp.routes.js) e fazer perguntas em linguagem natural tipo "quantos
 * tickets pendentes hoje" ou "busca a peça X no catálogo" — o Claude local
 * chama essas tools, que só LEEM dado que já existe (nenhuma delas manda
 * mensagem, muda status de ticket, nem grava nada). Não tem relação nenhuma
 * com o atendimento automático ao cliente (main.flow.js/ai.service.js) nem
 * com esta sessão de Cowork em si (que roda isolada na nuvem, sem acesso à
 * rede local do usuário) — só serve pra uma sessão de IA rodando NO PC do
 * usuário, se ele optar por configurar isso no `.mcp.json` dela.
 *
 * Cada tool é uma casca fina em cima de função de serviço que já existe —
 * nenhuma lógica de negócio nova, só tradução pro formato que o protocolo
 * MCP espera (content: [{ type: "text", text }]). Ver mcp.routes.js pra
 * autenticação (reaproveita authSession/API_TOKEN) e o gate MCP_ENABLED.
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = require("zod");

const { listTickets, getTicketStats } = require("./ticket.service");
const { buscarMetricas } = require("./metrics.service");
const { buscarPorCodigo, buscarPorNomePainel } = require("./catalogo-x2.service");
const { listHistoryByUser } = require("./history.service");
const { getConnectionInfo } = require("../config/whatsapp");

// Mesmos 4 status válidos de ticket.controller.js (STATUS_VALIDOS) — mantidos
// em sincronia manual de propósito (arquivo pequeno, duplicar aqui é mais
// simples que criar um módulo de constantes compartilhadas só por causa
// disso — ver princípio "DRY com critério" do CLAUDE.md).
const STATUS_TICKET = ["aberto", "em_andamento", "resolvido", "cancelado"];

function textoJson(valor) {
  return { content: [{ type: "text", text: JSON.stringify(valor, null, 2) }] };
}

function textoErro(mensagem) {
  return { content: [{ type: "text", text: mensagem }], isError: true };
}

/**
 * Cria uma instância NOVA do servidor MCP. Uma por requisição (modo
 * stateless do StreamableHTTPServerTransport, ver mcp.routes.js) — mesmo
 * padrão recomendado pela própria doc do SDK pra servidor HTTP sem sessão
 * dedicada: barato de criar (só registra as tools), evita qualquer estado
 * compartilhado entre chamadas de clientes diferentes.
 */
function criarServidorMcp() {
  const server = new McpServer({ name: "bot-rildon", version: "1.0.0" });

  server.registerTool(
    "listar_tickets",
    {
      title: "Listar tickets de atendimento",
      description:
        "Lista tickets de atendimento (conversas com cliente), com filtro opcional por status, texto de busca e período. Somente leitura.",
      inputSchema: {
        status: z.enum(STATUS_TICKET).optional().describe("Filtra por status exato do ticket."),
        search: z.string().optional().describe("Busca por texto livre (nome/telefone/protocolo)."),
        dateStart: z.string().optional().describe("Data inicial (YYYY-MM-DD)."),
        dateEnd: z.string().optional().describe("Data final (YYYY-MM-DD)."),
      },
    },
    async ({ status, search, dateStart, dateEnd }) => {
      try {
        const tickets = await listTickets({ status, search, dateStart, dateEnd });
        return textoJson(tickets);
      } catch (err) {
        return textoErro(`Erro ao listar tickets: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "estatisticas_tickets",
    {
      title: "Estatísticas de tickets",
      description:
        "Contagem de tickets por status num período (quantos abertos, em andamento, resolvidos, cancelados). Somente leitura.",
      inputSchema: {
        dateStart: z.string().optional().describe("Data inicial (YYYY-MM-DD)."),
        dateEnd: z.string().optional().describe("Data final (YYYY-MM-DD)."),
      },
    },
    async ({ dateStart, dateEnd }) => {
      try {
        const stats = await getTicketStats({ dateStart, dateEnd });
        return textoJson(stats);
      } catch (err) {
        return textoErro(`Erro ao buscar estatísticas: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "metricas_atendimento",
    {
      title: "Métricas do atendimento",
      description:
        "Relatório completo do painel de Métricas: tempo médio de resposta/resolução, ranking de atendentes, satisfação, evolução por dia/hora. Sem parâmetros — sempre o período padrão do painel. Somente leitura.",
      inputSchema: {},
    },
    async () => {
      try {
        const metricas = await buscarMetricas();
        return textoJson(metricas);
      } catch (err) {
        return textoErro(`Erro ao buscar métricas: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "buscar_produto_catalogo",
    {
      title: "Buscar produto no catálogo",
      description:
        "Busca peças no catálogo X2 por código (interno, do fabricante ou original/OEM) OU por nome/descrição — informe exatamente um dos dois. Somente leitura.",
      inputSchema: {
        codigo: z.string().optional().describe("Código do produto (interno, referência do fabricante, ou original/OEM)."),
        nome: z.string().optional().describe("Nome ou parte da descrição da peça."),
      },
    },
    async ({ codigo, nome }) => {
      if (!codigo && !nome) {
        return textoErro("Informe `codigo` ou `nome` para buscar.");
      }
      try {
        if (codigo) {
          const produtos = buscarPorCodigo(codigo, { limite: 20 });
          return textoJson({ total: produtos.length, produtos });
        }
        const resultado = buscarPorNomePainel(nome, { limite: 20 });
        return textoJson(resultado);
      } catch (err) {
        return textoErro(`Erro ao buscar no catálogo: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "historico_conversa",
    {
      title: "Histórico de conversa com um cliente",
      description:
        "Lista o histórico de mensagens trocadas com um número de WhatsApp específico (userId no formato salvo pelo bot, ex: 5582999999999@s.whatsapp.net). Somente leitura.",
      inputSchema: {
        userId: z.string().describe("Identificador do contato (número/JID do WhatsApp) — o mesmo usado no painel de Histórico."),
      },
    },
    async ({ userId }) => {
      try {
        const historico = await listHistoryByUser(userId);
        return textoJson(historico);
      } catch (err) {
        return textoErro(`Erro ao buscar histórico: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "status_whatsapp",
    {
      title: "Status da conexão do WhatsApp",
      description: "Diz se o bot está conectado ao WhatsApp agora e se há QR code pendente de leitura. Somente leitura.",
      inputSchema: {},
    },
    async () => {
      try {
        const info = getConnectionInfo();
        // Não devolve o QR cru (string longa, sem utilidade em texto) — só
        // se HÁ um pendente, pra não inflar a resposta à toa.
        return textoJson({ connected: info.connected, temQrPendente: !!info.qr });
      } catch (err) {
        return textoErro(`Erro ao checar status do WhatsApp: ${err.message}`);
      }
    }
  );

  return server;
}

module.exports = { criarServidorMcp };
