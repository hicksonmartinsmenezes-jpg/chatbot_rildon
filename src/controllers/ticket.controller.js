const logger = require("../utils/logger");
const humanMode = require("../services/humanMode.service");
const { emitEvent } = require("../services/socket.service");
const ticketRepository = require("../repositories/ticket.repository");
const { getProfilePhotoCandidates } = require("../whatsapp/lid-map");
const { sendMessage } = require("../config/whatsapp");
const { saveHistory } = require("../services/history.service");
const { getSettings } = require("../services/settings.service");
const { canAccessTicket, canManageTicket, canSeeSensitiveDashboard, canUseFullConversationPanel } = require("../utils/access-control");
const { dataHojeISO } = require("../utils/horario");
const {
  createTicket,
  listTickets,
  updateTicketStatus,
  clearReopenCooldown,
  getTicketStats,
  assignTicket,
  transferTicket
} = require("../services/ticket.service");

// CORRIGIDO: "atendimento" adicionado — mainFlow cria tickets com esse setor
const SETORES_VALIDOS = [
  "suporte", "vendas", "financeiro", "garantia", "geral", "atendimento", "gestao", "crediario"
];

const STATUS_VALIDOS = ["aberto", "em_andamento", "resolvido", "cancelado"];

async function postTicket(req, res) {
  try {
    const { userId, type, customerName, cpf, description, sector } = req.body || {};

    // CORRIGIDO: validação de campos obrigatórios
    if (!userId) {
      return res.status(400).json({ error: "userId é obrigatório." });
    }
    if (!type) {
      return res.status(400).json({ error: "type é obrigatório." });
    }

    const ticket = await createTicket({ userId, type, customerName, cpf, description, sector });

    res.status(201).json({ ok: true, ticket });
  } catch (err) {
    logger.error(`[postTicket] ${err.message}`);
    res.status(400).json({ error: err.message || "Erro ao criar ticket." });
  }
}

async function getTickets(req, res) {
  try {
    const { status, search, dateStart, dateEnd } = req.query;

    // CORRIGIDO: validação de status antes de passar ao repositório
    if (status && !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({
        error: `Status inválido. Use: ${STATUS_VALIDOS.join(", ")}`
      });
    }

    let tickets = await listTickets({ status, search, dateStart, dateEnd });

    // BUG CORRIGIDO: com ATTENDANT_CONVERSATIONS_FULL_ACCESS=false (modo
    // restrito — cada atendente só vê/gerencia o que assumiu + o que ainda
    // está livre no seu setor), os tickets filtrados aqui embaixo somem por
    // completo da resposta. Isso deixava a aba "Conversas" do atendente
    // confusa: um ticket assumido/fechado por OUTRO atendente (ex: Junior)
    // some da lista de tickets, mas o cliente continua aparecendo em
    // "Pendentes" pro atendente que não é dono, com o botão "Iniciar
    // Atendimento" (o frontend trata "sem ticket na resposta" como
    // "cliente novo, ainda no bot" — não tinha como distinguir isso de
    // "ticket existe, só não é seu"). Por isso, além de filtrar a lista
    // principal, mandamos separadamente TODOS os userIds ocultados (não só
    // os com ticket aberto/em_andamento — um ticket JÁ FECHADO por outro
    // atendente também precisa ficar oculto, senão reaparece exatamente
    // como esse bug) — o frontend usa isso pra esconder essas conversas
    // por completo, em vez de mostrá-las incorretamente como pendentes.
    let hiddenActiveUserIds = [];
    if (req.user?.perfil === "atendente" && !canUseFullConversationPanel(req.user)) {
      const antes = tickets;
      tickets = antes.filter(ticket => {
        // Pedido do usuário: tickets já FECHADOS (resolvido/cancelado) são
        // histórico — sem disputa de "de quem é" — então aparecem iguais
        // pra todo mundo, igual um admin veria.
        //
        // ATUALIZADO (pedido do usuário): "Pendentes" (status "aberto", sem
        // atendente ainda) também deve aparecer IDÊNTICO pra todos os
        // atendentes, igual Fechados — inclusive um ticket recém-reaberto
        // (reopenTicketIfClosed volta o status pra "aberto" e limpa
        // assigned_to). Antes, um pendente de OUTRO setor ficava escondido
        // pro atendente, então dois atendentes viam listas de pendentes
        // diferentes — o usuário reportou isso ao reabrir um atendimento.
        // A restrição por setor/atribuição agora vale só pra "em_andamento"
        // (ticket já ASSUMIDO por alguém) — é aí que faz sentido não expor
        // o atendimento ativo de outro atendente; um ticket ainda livre não
        // tem "dono" nenhum pra disputar.
        if (ticket.status === "resolvido" || ticket.status === "cancelado" || ticket.status === "aberto") {
          return true;
        }

        const mesmoSetor = (ticket.sector || "geral") === (req.user.sector || "geral");
        const disponivel  = !ticket.assignedTo;
        const jaAssumido  = ticket.assignedTo === req.user.id;
        return (mesmoSetor && disponivel) || jaAssumido;
      });

      const idsVisiveis = new Set(tickets.map(t => t.userId));
      hiddenActiveUserIds = antes
        .filter(t => !idsVisiveis.has(t.userId))
        .map(t => t.userId);
    }

    const stats     = await getTicketStats({ dateStart, dateEnd });
    const liveStats = await getTicketStats({}); // sem filtro de data = estado atual real

    // Estatísticas fixas de HOJE (fuso do negócio) — o card "Encerrados" do
    // Dashboard reflete o dia, independente do filtro de data no topo.
    const hoje       = dataHojeISO();
    const todayStats = await getTicketStats({ dateStart: hoje, dateEnd: hoje });

    // Pedido do usuário: quando um ticket é assumido/transferido/fechado por
    // OUTRO atendente enquanto eu já estava com a conversa aberta na tela,
    // os botões de ação (Transferir/Fechar/Devolver ao bot) continuavam
    // aparecendo como se fossem meus — clicar só dava 403 (o backend já
    // bloqueia certo, a UI que não avisava antes). O frontend usa esse flag
    // pra saber se DEVE mostrar os botões de ação normalmente (fullAccess
    // ou privilegiado) ou só quando o ticket for realmente meu/livre.
    const canManageAnyTicket = canUseFullConversationPanel(req.user);

    res.json({ stats, liveStats, todayStats, total: tickets.length, tickets, hiddenActiveUserIds, canManageAnyTicket });
  } catch (err) {
    logger.error(`[getTickets] ${err.message}`);
    res.status(500).json({ error: "Erro ao listar tickets." });
  }
}

async function patchTicket(req, res) {
  try {
    const id = req.params.id;

    // CORRIGIDO: garante que status é string antes de incluir
    const status = typeof req.body?.status === "string" ? req.body.status : "";

    if (!STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({
        error: `Status inválido. Use: ${STATUS_VALIDOS.join(", ")}`
      });
    }

    const atual = await ticketRepository.findByIdOrProtocol(id);
    if (!atual) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }
    if (!canManageTicket(req.user, atual)) {
      return res.status(403).json({ error: "Você não tem permissão para alterar este ticket." });
    }

    // BUG CORRIGIDO (relatado pelo usuário): "se o cliente estiver ativo com
    // outro usuário, ainda aparece a possibilidade de reabrir em Fechados —
    // se clicar, rouba o cliente do outro atendente". Isso acontece quando o
    // painel de quem está olhando Fechados está com dado desatualizado
    // (corrida: outro atendente já assumiu um ticket mais novo pra esse
    // mesmo cliente, mas o socket/reload ainda não chegou nessa aba) — o
    // clique em "Reabrir" reabre um ticket ANTIGO já resolvido, sem saber
    // que já existe um ticket ATIVO (em_andamento) pro mesmo cliente,
    // criando dois tickets conflitantes pro mesmo userId. A validação
    // precisa estar no servidor (fonte da verdade), não só confiar no
    // estado do navegador — bloqueia a reabertura se já houver outro
    // ticket em_andamento pra esse cliente.
    if (status === "aberto") {
      // BUG CORRIGIDO: a checagem original comparava só o userId exato do
      // ticket (user_id = $1), mas o mesmo cliente pode ter tickets salvos
      // com formatos DIFERENTES de identificador — o WhatsApp entrega
      // mensagens como "...@lid" (dispositivo vinculado) que às vezes é
      // resolvido pra "...@s.whatsapp.net" e às vezes não (ver
      // LID_FALLBACK em src/config/whatsapp.js), dependendo do que o
      // Baileys anexou naquela mensagem específica. Resultado: um ticket
      // antigo (fechado) pode estar salvo como "123@lid" e o ticket novo
      // (em_andamento) do MESMO cliente real como "5511...@s.whatsapp.net"
      // — a comparação exata não achava o segundo, então o guard nunca
      // disparava e o "roubo de cliente" continuava acontecendo na prática
      // (reportado pelo usuário mesmo após o fix anterior). Usamos o mesmo
      // conjunto de identificadores equivalentes (lid ↔ jid) já usado para
      // foto de perfil em src/whatsapp/lid-map.js, e buscamos tickets em
      // QUALQUER um desses formatos antes de liberar a reabertura.
      const candidatos = getProfilePhotoCandidates(atual.userId);
      const outrosTickets = await ticketRepository.findByUserIds(
        candidatos.length ? candidatos : [atual.userId]
      );
      const emAtendimento = outrosTickets.find(
        t => String(t.id) !== String(atual.id) && t.status === "em_andamento"
      );
      if (emAtendimento) {
        return res.status(409).json({
          error: `Este cliente já está em atendimento ativo com ${emAtendimento.assignedToName || "outro atendente"}.`,
          assignedToName: emAtendimento.assignedToName || null
        });
      }
    }

    const ticket = await updateTicketStatus(id, status);

    // Ticket fechado → bot volta a responder este cliente
    if (status === "resolvido" || status === "cancelado") {
      humanMode.desativar(ticket.userId, "ticket_fechado");

      // BUG CORRIGIDO: ver comentário em ticket.service.js — o cooldown de
      // reabertura automática (reopenTicketIfClosed) ficava ativo por 60s
      // após qualquer reabertura anterior. Se o ticket fosse fechado de
      // novo dentro dessa janela, a PRÓXIMA mensagem do cliente não
      // reabria (cooldown ainda vigente), mesmo o ticket estando
      // legitimamente fechado agora. Um fechamento novo zera o cooldown —
      // a próxima mensagem sempre pode reabrir, sem depender de quanto
      // tempo falta pra um cooldown de um episódio anterior expirar.
      clearReopenCooldown(ticket.userId);
    }

    // Só pra "resolvido" — ver nota na função acima.
    if (status === "resolvido") {
      await enviarPesquisaSatisfacao(ticket);
    }

    // BUG CORRIGIDO: nenhum evento de socket avisava o painel de outras
    // sessões conectadas quando um ticket mudava de status (fechar,
    // reabrir, cancelar) — só a aba que fez a ação via a mudança de
    // verdade (via reload local); outras abas/atendentes ficavam com o
    // status antigo até o poll de 30s. Reportado pelo usuário como
    // "fechar não atualiza".
    emitEvent("ticket_atualizado", { ticket });

    res.json({ message: "Status atualizado.", ticket });
  } catch (err) {
    logger.error(`[patchTicket] ${err.message}`);
    res.status(500).json({ error: "Erro ao atualizar ticket." });
  }
}

// Pedido do usuário: quando um atendente/supervisor aceita um
// atendimento, o cliente recebe automaticamente uma mensagem se
// apresentando — pelo MESMO número do bot (sem trocar de canal/WhatsApp,
// ver decisão de não seguir com multi-número por ora). "{nome}" no
// template (settings.atendimento.mensagemSaudacaoAtendente) é trocado
// pelo nome de quem assumiu. Deixe o template em branco pra desativar.
// Best-effort: falha aqui não derruba a resposta de "aceitar" — o
// atendente já assumiu o ticket de verdade mesmo se a saudação falhar.
async function enviarSaudacaoAtendente(ticket, user) {
  try {
    const settings = await getSettings();
    const template = settings?.atendimento?.mensagemSaudacaoAtendente;
    if (!template || !template.trim()) return;

    const nome = user?.nome || user?.usuario || "Atendente";
    const mensagem = template.replace(/\{nome\}/g, nome);

    const sent = await sendMessage(ticket.userId, mensagem);

    const historyItem = await saveHistory({
      userId: ticket.userId,
      contactName: ticket.customerName || "",
      message: null,
      response: mensagem,
      sector: "manual",
      messageId: sent?.id || null,
      status: "sent"
    });

    emitEvent("nova_mensagem", {
      userId: ticket.userId,
      contactName: ticket.customerName || "",
      message: null,
      response: mensagem,
      sector: "manual",
      messageId: sent?.id || null,
      status: "sent",
      createdAt: historyItem?.createdAt || new Date()
    });
  } catch (err) {
    logger.warn(`[enviarSaudacaoAtendente] falhou para ticket #${ticket?.protocolo}: ${err.message}`);
  }
}

// Pedido do usuário: pesquisa de satisfação automática ao fechar um
// atendimento (status → resolvido). O cliente responde só com um número
// de 1 a 5 — a resposta é capturada em message.service.js (processMessage),
// ANTES do fluxo normal do bot, então não conta como pedido novo nem
// reabre o ticket. Só dispara pra "resolvido" (um "cancelado" geralmente
// não teve atendimento de verdade pra avaliar). Best-effort, mesmo padrão
// de enviarSaudacaoAtendente.
async function enviarPesquisaSatisfacao(ticket) {
  try {
    const settings = await getSettings();
    const template = settings?.atendimento?.mensagemPesquisaSatisfacao;
    if (!template || !template.trim()) return;

    const sent = await sendMessage(ticket.userId, template);

    await ticketRepository.askSatisfaction(ticket.id);

    const historyItem = await saveHistory({
      userId: ticket.userId,
      contactName: ticket.customerName || "",
      message: null,
      response: template,
      sector: "manual",
      messageId: sent?.id || null,
      status: "sent"
    });

    emitEvent("nova_mensagem", {
      userId: ticket.userId,
      contactName: ticket.customerName || "",
      message: null,
      response: template,
      sector: "manual",
      messageId: sent?.id || null,
      status: "sent",
      createdAt: historyItem?.createdAt || new Date()
    });
  } catch (err) {
    logger.warn(`[enviarPesquisaSatisfacao] falhou para ticket #${ticket?.protocolo}: ${err.message}`);
  }
}

async function assumirTicket(req, res) {
  try {
    const id = req.params.id;

    const atual = await ticketRepository.findByIdOrProtocol(id);
    if (!atual) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }
    if (!canAccessTicket(req.user, atual, { allowUnassigned: true })) {
      return res.status(403).json({ error: "Você não tem permissão para assumir este ticket." });
    }

    const ticket = await assignTicket(id, req.user);

    if (!ticket || ticket.notFound) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }
    if (ticket.alreadyAssigned) {
      // Informa QUEM já assumiu, em vez de só "outro atendente" — evita o
      // atendente ter que abrir o ticket de novo pra descobrir com quem falar.
      const nome = ticket.assignedToName;
      return res.status(409).json({
        error: nome ? `Ticket já foi assumido por ${nome}.` : "Ticket já foi assumido por outro atendente.",
        assignedToName: nome || null
      });
    }

    // Atendente assumiu → pausa o bot para este cliente até o ticket fechar
    humanMode.ativar(ticket.userId, {
      agentName: req.user?.nome || req.user?.usuario || "",
      protocolo: ticket.protocolo
    });

    // Ver nota em patchTicket — mantém outras sessões do painel em sincronia.
    emitEvent("ticket_atualizado", { ticket });

    // Best-effort (ver função acima, nunca lança) — aguardamos pra garantir
    // que a saudação foi de fato tentada antes de responder, evitando uma
    // promise solta que poderia terminar depois do processo encerrar.
    await enviarSaudacaoAtendente(ticket, req.user);

    res.json({ ok: true, ticket });
  } catch (err) {
    logger.error(`[assumirTicket] ${err.message}`);
    res.status(500).json({ error: "Erro ao assumir ticket." });
  }
}

async function transferirTicket(req, res) {
  try {
    const id = req.params.id;
    const { sector, toUserId } = req.body || {};

    const atual = await ticketRepository.findByIdOrProtocol(id);
    if (!atual) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }
    if (!canManageTicket(req.user, atual)) {
      return res.status(403).json({ error: "Você não tem permissão para transferir este ticket." });
    }

    let targetUser = null;

    if (toUserId) {
      const userRepository = require("../repositories/user.repository");
      targetUser = await userRepository.findById(toUserId);
      if (!targetUser) {
        return res.status(404).json({ error: "Atendente não encontrado." });
      }
    } else {
      if (!sector) {
        return res.status(400).json({ error: "Informe toUserId ou sector." });
      }
      if (!SETORES_VALIDOS.includes(sector.toLowerCase())) {
        return res.status(400).json({
          error: `Setor inválido. Use: ${SETORES_VALIDOS.join(", ")}`
        });
      }
    }

    const ticket = await transferTicket(id, targetUser?.sector || sector?.toLowerCase() || "geral", targetUser);

    if (!ticket) {
      return res.status(404).json({ error: "Ticket não encontrado." });
    }

    // Ver nota em patchTicket — mantém outras sessões do painel em sincronia.
    emitEvent("ticket_atualizado", { ticket });

    res.json({ ok: true, ticket });
  } catch (err) {
    logger.error(`[transferirTicket] ${err.message}`);
    res.status(500).json({ error: "Erro ao transferir ticket." });
  }
}

// CORRIGIDO: dashboard calculado em SQL via getTicketStats() + query dedicada
// em vez de carregar todos os tickets em memória e calcular em JS
async function getTicketDashboard(req, res) {
  try {
    if (!canSeeSensitiveDashboard(req.user)) {
      return res.status(403).json({ error: "Acesso permitido apenas para supervisores e administradores." });
    }

    const pool = require("../database/postgres");
    // Timezone configurável via .env para evitar hardcode por região
    const TZ = process.env.TZ_NEGOCIO || "America/Maceio";

    const [statsRes, setorRes, atendenteRes, hojeRes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'aberto')::int       AS aberto,
          COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS em_andamento,
          COUNT(*) FILTER (WHERE status = 'resolvido')::int    AS resolvido,
          COUNT(*) FILTER (WHERE status = 'cancelado')::int    AS cancelado
        FROM tickets
      `),
      pool.query(`
        SELECT COALESCE(sector,'geral') AS setor, COUNT(*)::int AS total
        FROM tickets
        GROUP BY setor
        ORDER BY total DESC
      `),
      pool.query(`
        SELECT assigned_to_name AS nome, COUNT(*)::int AS total
        FROM tickets
        WHERE assigned_to_name IS NOT NULL
        GROUP BY assigned_to_name
        ORDER BY total DESC
      `),
      pool.query(`
        SELECT COUNT(*)::int AS total
        FROM tickets
        WHERE DATE(created_at AT TIME ZONE $1) = CURRENT_DATE
      `, [TZ])
    ]);

    const s = statsRes.rows[0];

    const porSetor = {};
    for (const row of setorRes.rows) porSetor[row.setor] = row.total;

    const porAtendente = {};
    for (const row of atendenteRes.rows) porAtendente[row.nome] = row.total;

    res.json({
      total: s.total,
      hoje: hojeRes.rows[0].total,
      porStatus: {
        aberto:       s.aberto,
        em_andamento: s.em_andamento,
        resolvido:    s.resolvido,
        cancelado:    s.cancelado
      },
      porSetor,
      porAtendente
    });
  } catch (err) {
    logger.error(`[getTicketDashboard] ${err.message}`);
    res.status(500).json({ error: "Erro ao gerar dashboard." });
  }
}

module.exports = {
  postTicket,
  getTickets,
  patchTicket,
  assumirTicket,
  transferirTicket,
  getTicketDashboard
};
