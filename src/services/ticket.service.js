const ticketRepository = require("../repositories/ticket.repository");
const { getSession, updateSession } = require("./session.service");
const logger = require("../utils/logger");
const { emitEvent } = require("./socket.service");
const { getProfilePhotoCandidates } = require("../whatsapp/lid-map");
const { getSettings } = require("./settings.service");

// Janela em que uma pesquisa de satisfação enviada continua "pendente"
// (aceitando a nota do cliente) antes de ser considerada expirada.
const SATISFACTION_WINDOW_MS =
  Number(process.env.SATISFACTION_SURVEY_WINDOW_HOURS || 48) * 60 * 60 * 1000;

// Pedido do usuário: em vez de SEMPRE reabrir o mesmo ticket fechado quando
// o cliente manda mensagem de novo (protocolo antigo reciclado pra um
// assunto possivelmente sem nenhuma relação, dias ou semanas depois — o que
// distorce métricas como tempo médio de atendimento), só reabre se o
// fechamento foi RECENTE. Fora dessa janela, reopenTicketIfClosed() retorna
// false e o fluxo normal segue — um ticket novo é criado naturalmente
// quando o cliente pedir algo (mesmo caminho de um cliente novo). Dentro da
// janela, cobre o caso real de atendimento encerrado por engano (timeout de
// inatividade, por exemplo) e o cliente responder poucos minutos depois —
// aí sim é a mesma conversa, não um atendimento novo.
const REOPEN_WINDOW_MS =
  Number(process.env.TICKET_REOPEN_WINDOW_MINUTOS || 60) * 60 * 1000;

// Cooldown de reabertura: evita reabrir o mesmo ticket múltiplas vezes em rajada
const _reopenCooldown = new Map();
// .unref() — não deve impedir o processo de encerrar (graceful shutdown/testes)
setInterval(() => _reopenCooldown.clear(), 5 * 60 * 1000).unref();

// Mapeamento type → sector. "atendente_humano" agora mapeado explicitamente.
const TYPE_TO_SECTOR = {
  duvida_financeira:   "financeiro",
  atendente_financeiro:"financeiro",
  consultor_vendas:    "vendas",
  orcamento:           "vendas",
  suporte_tecnico:     "suporte",
  suporte_humano:      "suporte",
  garantia:            "garantia",
  // CORRIGIDO: atendente_humano → "atendimento" (consistente com main.flow)
  atendente_humano:    "atendimento"
};

async function createTicket({
  userId,
  type,
  customerName,
  cpf,
  description,
  sector: sectorOverride
}) {
  // BUG CORRIGIDO (relatado pelo usuário: cliquei em Aceitar e ficou em
  // Pendentes, cliquei em Fechar e foi pra Ativos): o bot continua
  // respondendo normalmente enquanto um ticket criado espera um atendente
  // aceitar — humanMode só pausa o bot DEPOIS do "Aceitar" (ver
  // assumirTicket em ticket.controller.js). Se o cliente manda outro
  // pedido nesse meio-tempo (ex: pede orçamento de uma 2ª peça antes de
  // ser aceito), o fluxo criava um ticket NOVO em paralelo pro mesmo
  // cliente. O painel só guarda "um ticket mais recente por cliente"
  // (ticketsByUser no frontend) — com dois tickets ativos ao mesmo tempo,
  // qual deles é "o mais recente" muda conforme o status de cada um muda,
  // e os botões Aceitar/Fechar (montados com o ticketId do ticket errado)
  // acabavam agindo no ticket que NÃO estava na tela. Agora, se já existe
  // um ticket ativo (aberto ou em_andamento) pro mesmo cliente, reaproveita
  // ele — anexando a nova descrição — em vez de criar um segundo.
  const candidatos = getProfilePhotoCandidates(userId);
  const existentes = await ticketRepository.findByUserIds(candidatos.length ? candidatos : [userId]);
  const ativo = existentes.find(t => t.status === "aberto" || t.status === "em_andamento");
  if (ativo) {
    logger.info(`[createTicket] Ticket ativo #${ativo.protocolo} já existe para ${userId} — anexando pedido novo em vez de criar outro`);
    if (description) {
      const atualizado = await ticketRepository.prependDescription(ativo.id, description);
      if (atualizado) return atualizado;
    }
    return ativo;
  }

  const protocolo = await ticketRepository.gerarProtocolo();
  const sector = sectorOverride || TYPE_TO_SECTOR[type] || "geral";

  const ticket = {
    protocolo,
    userId,
    type,
    customerName: customerName || "Não informado",
    cpf: cpf || "Não informado",
    description: description || "",
    status: "aberto",
    sector,
    assignedTo: null,
    assignedToName: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };

  const criado = await ticketRepository.create(ticket);

  logger.info(`Ticket criado: #${criado.protocolo} (${type}) setor=${sector}`);

  return criado;
}

async function listTickets({ status, search, dateStart, dateEnd } = {}) {
  return ticketRepository.findAll({ status, search, dateStart, dateEnd });
}

async function updateTicketStatus(id, status) {
  return ticketRepository.updateStatus(id, status);
}

async function getTicketStats({ dateStart, dateEnd } = {}) {
  return ticketRepository.stats({ dateStart, dateEnd });
}

async function getTicketsByCPF(cpf) {
  const cpfLimpo = String(cpf || "").replace(/\D/g, "");
  if (!cpfLimpo) return [];
  return ticketRepository.findByCpf(cpfLimpo);
}

// BUG CORRIGIDO: o cooldown ficava ativo por 60s após QUALQUER reabertura
// bem-sucedida e nunca era limpo nesse caminho — só no ramo "não precisava
// reabrir". Se o atendente fechasse o ticket de NOVO dentro dessa janela de
// 60s (fluxo normal: reabre automático → atendente fecha de novo rápido) e
// o cliente mandasse outra mensagem, o cooldown ainda ativo bloqueava o
// reopen SILENCIOSAMENTE (return false sem nem checar o status atual) —
// reportado pelo usuário como "fechei, mandei mensagem de novo, não
// reaparece em pendentes" (só voltava a funcionar depois que o cooldown
// expirava sozinho, o que o usuário confundiu com "hard refresh resolveu").
// clearReopenCooldown() é chamado por ticket.controller.js sempre que um
// ticket é fechado manualmente — um fechamento novo é um estado novo, que
// merece poder reabrir de novo imediatamente na próxima mensagem.
function clearReopenCooldown(userId) {
  _reopenCooldown.delete(userId);
}

async function reopenTicketIfClosed(userId) {
  const lastReopen = _reopenCooldown.get(userId);
  if (lastReopen && Date.now() - lastReopen < 60_000) return false;

  // Marca antes do await para bloquear requests simultâneos (guard otimista)
  _reopenCooldown.set(userId, Date.now());

  try {
    // BUG CORRIGIDO: mesma causa raiz do guard de "roubo de cliente" em
    // ticket.controller.js — o WhatsApp entrega mensagens do mesmo cliente
    // ora como "...@lid" ora já resolvidas para "...@s.whatsapp.net" (ver
    // LID_FALLBACK em src/config/whatsapp.js). Buscar só por userId exato
    // fazia esta função não achar o ticket fechado do cliente quando ele
    // estava salvo no OUTRO formato — em vez de reabrir, o fluxo seguinte
    // criava um ticket NOVO duplicado (o antigo ficava fechado, órfão).
    // getProfilePhotoCandidates monta o conjunto de identificadores
    // equivalentes (lid ↔ jid) já usado para foto de perfil.
    const candidatos = getProfilePhotoCandidates(userId);
    const tickets = await ticketRepository.findByUserIds(candidatos.length ? candidatos : [userId]);
    if (!tickets.length) { _reopenCooldown.delete(userId); return false; }

    const latest = tickets[0]; // já ordenado DESC
    const fechadoRecentemente =
      latest.updatedAt && (Date.now() - new Date(latest.updatedAt).getTime()) <= REOPEN_WINDOW_MS;

    if ((latest.status === "resolvido" || latest.status === "cancelado") && !fechadoRecentemente) {
      // Fechado há mais tempo que a janela — trata como se não houvesse
      // ticket reabrível. O fluxo normal segue e cria um ticket NOVO quando
      // o cliente de fato pedir algo (não força criação aqui: uma simples
      // saudação, por exemplo, não deveria virar ticket sozinha).
      _reopenCooldown.delete(userId);
      return false;
    }

    if (latest.status === "resolvido" || latest.status === "cancelado") {
      const reaberto = await ticketRepository.updateStatus(latest.id, "aberto");
      logger.info(`Ticket #${latest.protocolo} reaberto para ${userId}`);

      // BUG CORRIGIDO (relatado pelo usuário): esta reabertura automática
      // (cliente manda mensagem de novo depois do atendimento fechado)
      // atualizava o status no banco só por aqui, sem passar pelo
      // ticket.controller.js — por isso nunca emitia "ticket_atualizado".
      // O painel só via o cliente voltar pra "Pendentes" depois de um
      // reload manual/poll de 30s, e a badge de notificação não refletia
      // a mudança de aba. Mesmo evento usado pelas ações manuais
      // (assumir/transferir/fechar) do ticket.controller.js.
      if (reaberto) emitEvent("ticket_atualizado", { ticket: reaberto });

      return true;
    }

    _reopenCooldown.delete(userId);
    return false;
  } catch (err) {
    _reopenCooldown.delete(userId); // libera em caso de erro para não bloquear forever
    throw err;
  }
}

async function assignTicket(id, user) {
  return ticketRepository.assign(id, user);
}

async function transferTicket(id, sector, targetUser = null) {
  return ticketRepository.transfer(id, sector, targetUser);
}

// Pedido do usuário: pesquisa de satisfação ao fechar atendimento. O
// cliente responde só com um número de 1 a 5 — parseSatisfactionRating
// tenta reconhecer isso em textos curtos como "5", "5 estrelas", "nota 5"
// ou "5/5". Mensagens longas ou sem exatamente um dígito 1-5 isolado não
// contam (evita confundir um CPF/telefone digitado por acaso com nota).
//
// LIMITAÇÃO CONHECIDA: como usa o mesmo canal de conversa normal, se o
// cliente mandar só um dígito 1-5 por outro motivo (ex: escolher uma opção
// de menu do bot) DENTRO da janela de pesquisa pendente (default 48h após
// fechar), isso seria interpretado como nota em vez de seguir o fluxo do
// bot. Janela curta + só disparar quando o ticket é fechado como
// "resolvido" (não em qualquer mensagem a qualquer momento) minimiza esse
// risco — aceito como trade-off razoável pro escopo pedido.
function parseSatisfactionRating(message) {
  const texto = String(message || "").trim();
  if (!texto || texto.length > 30) return null;
  const match = texto.match(/(?<!\d)([1-5])(?:\s*\/\s*5)?(?!\d)/);
  return match ? Number(match[1]) : null;
}

// Chamado em message.service.js ANTES de reopenTicketIfClosed — se o
// cliente tem uma pesquisa pendente e a mensagem parece uma nota válida,
// registra e retorna a resposta de agradecimento SEM reabrir o ticket nem
// passar pelo fluxo normal do bot. Retorna null se não há pesquisa
// pendente ou se a mensagem não foi reconhecida como nota (nesse caso o
// fluxo normal segue — inclusive podendo reabrir o ticket normalmente).
// BUG CORRIGIDO (relatado pelo usuário: "1" pra escolher o menu foi
// engolido como nota 1 estrela de uma pesquisa de dias atrás): o guard
// antigo olhava só pro banco (ticket resolvido + pesquisa pendente + até
// 48h desde o envio) — então QUALQUER dígito 1-5 vindo do mesmo cliente
// dentro dessa janela, em qualquer conversa nova e sem relação nenhuma
// com a pesquisa, era interceptado como resposta dela. Agora também
// exige a flag de sessão aguardandoNotaSatisfacao — setada só no momento
// exato em que a pesquisa é de fato entregue (enviarPesquisaSatisfacao em
// ticket.controller.js) e limpa na primeira resposta seguinte (some
// junto com a sessão inteira em qualquer saudação/menu, ou é limpa aqui
// mesmo se a resposta não parecer uma nota válida) — só a mensagem
// IMEDIATAMENTE seguinte à pesquisa pode ser interpretada como nota.
async function handleSatisfactionReply({ userId, message }) {
  const session = getSession(userId);
  if (!session.aguardandoNotaSatisfacao) return null;

  const candidatos = getProfilePhotoCandidates(userId);
  const tickets = await ticketRepository.findByUserIds(candidatos.length ? candidatos : [userId]);

  const pendente = tickets.find(t =>
    t.status === "resolvido" &&
    t.satisfactionAskedAt &&
    !t.satisfactionRating &&
    (Date.now() - new Date(t.satisfactionAskedAt).getTime()) < SATISFACTION_WINDOW_MS
  );
  if (!pendente) {
    await updateSession(userId, { aguardandoNotaSatisfacao: undefined }, { skipTimer: true });
    return null;
  }

  const rating = parseSatisfactionRating(message);
  if (!rating) {
    // Não pareceu uma nota — não fica esperando pra sempre; limpa a flag
    // e deixa a mensagem seguir o fluxo normal (menu, IA, etc.).
    await updateSession(userId, { aguardandoNotaSatisfacao: undefined }, { skipTimer: true });
    return null;
  }

  const atualizado = await ticketRepository.rateSatisfaction(pendente.id, rating);
  await updateSession(userId, { aguardandoNotaSatisfacao: undefined }, { skipTimer: true });
  logger.info(`[Satisfação] Ticket #${pendente.protocolo} avaliado com nota ${rating}`);

  const settings = await getSettings();
  const agradecimento =
    settings?.atendimento?.mensagemAgradecimentoPesquisa ||
    "Muito obrigado pela sua avaliação!";

  return { ticket: atualizado, rating, response: agradecimento };
}

module.exports = {
  createTicket,
  listTickets,
  updateTicketStatus,
  reopenTicketIfClosed,
  clearReopenCooldown,
  assignTicket,
  transferTicket,
  getTicketStats,
  getTicketsByCPF,
  parseSatisfactionRating,
  handleSatisfactionReply
};
