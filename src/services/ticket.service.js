const ticketRepository = require("../repositories/ticket.repository");
const { getSession, updateSession } = require("./session.service");
const logger = require("../utils/logger");
const { emitEvent } = require("./socket.service");
const { getProfilePhotoCandidates } = require("../whatsapp/lid-map");
const { getSettings } = require("./settings.service");
const { sanitizarTexto, normalizar } = require("../utils/validators");
const { marcarComoCliente } = require("./contacts.service");

// Janela em que uma pesquisa de satisfação enviada continua "pendente"
// (aceitando a nota do cliente) antes de ser considerada expirada.
const SATISFACTION_WINDOW_MS =
  Number(process.env.SATISFACTION_SURVEY_WINDOW_HOURS || 48) * 60 * 60 * 1000;

// Pedido do usuário (2026-07-21): nota 1 ou 2 (de 5) é considerada baixa —
// dispara a pergunta extra "o que podemos melhorar?" antes do agradecimento
// final (ver handleSatisfactionReply abaixo). Nota 3 fica de fora
// deliberadamente (neutra, não necessariamente uma reclamação) — ajustável
// aqui se a loja quiser cobrir nota 3 também.
const SATISFACTION_LOW_THRESHOLD = 2;

// BUG REAL (relatado pelo usuário, teste ao vivo 2026-07-27): cliente avaliou
// o atendimento ("Hoje foi 5"), foi agradecido, e minutos depois mandou só
// "👍" — o bot tratou como pergunta nova, a IA falhou (fallback técnico) e
// devolveu o menu inteiro. Uma resposta estranha pra uma reação de
// despedida. Em vez de um "tempo de espera" genérico antes do bot voltar a
// responder pro cliente (o que arriscaria IGNORAR uma dúvida nova de
// verdade logo em seguida), a janela abaixo só vale combinada com
// _pareceApenasAgradecimentoFinal — ou seja, só mensagens que são
// inequivocamente um agradecimento/reação de despedida, chegando pouco
// depois da nota, são silenciadas. Qualquer outra coisa (pergunta, palavra
// fora da lista, mensagem longa) segue o fluxo normal do bot.
const POS_AVALIACAO_ACK_WINDOW_MS =
  Number(process.env.POS_AVALIACAO_ACK_WINDOW_MIN || 30) * 60 * 1000;

// Lista deliberadamente curta de despedidas/agradecimentos — mesmo espírito
// de _pareceCorrecaoDePeca em vendas.flow.js (restrito o bastante pra não
// engolir uma mensagem legítima por engano).
const AGRADECIMENTO_FINAL_RE =
  /^(obrigad[oa]o?s?|obg|valeu|vlw|brigad[oa]o?|de nada|show|top|blz|ok|okay|beleza|otimo|excelente|perfeito|isso ai|isso mesmo|gratid(a|ã)o)$/;

function _pareceApenasAgradecimentoFinal(message) {
  const texto = String(message || "").trim();
  if (!texto || texto.length > 40) return false;

  // Mensagem só de emoji/reação (👍, 🙏, ❤️, 😊 etc.), sem nenhuma letra/número.
  const temEmoji = /\p{Extended_Pictographic}/u.test(texto);
  const soEmoji  = temEmoji && !/[\p{L}\p{N}]/u.test(texto);
  if (soEmoji) return true;

  // Texto curto de agradecimento/despedida (normalizado, sem pontuação/emoji).
  const normalizado = normalizar(texto).replace(/[^\p{L}\s]/gu, "").trim();
  return AGRADECIMENTO_FINAL_RE.test(normalizado);
}

// Chamado em message.service.js logo depois de handleSatisfactionReply (e
// ANTES de reopenTicketIfClosed) — se o cliente já avaliou um atendimento
// recentemente e manda só um agradecimento/reação de despedida, não reabre o
// ticket nem aciona o fluxo do bot pra essa mensagem específica (ela é só
// salva no histórico, sem resposta). Retorna false pra qualquer outra coisa,
// inclusive se não houver avaliação recente — nesse caso o fluxo normal
// segue (main.flow.js decide o que responder).
async function pareceEncerramentoPosAvaliacao(userId, message) {
  if (!_pareceApenasAgradecimentoFinal(message)) return false;

  const candidatos = getProfilePhotoCandidates(userId);
  const tickets = await ticketRepository.findByUserIds(candidatos.length ? candidatos : [userId]);

  return tickets.some(t =>
    t.status === "resolvido" &&
    t.satisfactionRatedAt &&
    (Date.now() - new Date(t.satisfactionRatedAt).getTime()) < POS_AVALIACAO_ACK_WINDOW_MS
  );
}

// BUG DA MESMA CLASSE JÁ CORRIGIDO ANTES NESTE PROJETO (ver comentários em
// vendas.flow.js: pergunta de crediário engolida como nome; correção de
// peça engolida como veículo): a etapa 2 de handleSatisfactionReply captura
// CEGAMENTE a próxima mensagem do cliente como o texto de "o que podemos
// melhorar" — sem esse escape, um cliente que digitasse "menu"/"0" ou
// simplesmente mandasse uma saudação pra recomeçar teria essa mensagem
// engolida e salva como se fosse feedback, em vez de voltar pro menu.
// Restrito a marcadores INEQUÍVOCOS de navegação (ninguém escreve só "oi"
// ou "menu" como feedback de satisfação) — não tenta adivinhar se o texto
// é "na verdade um pedido novo" (ex: "preciso de outro orçamento"), porque
// isso usa vocabulário legítimo demais em comum com reclamação real sobre
// o atendimento pra distinguir com segurança via regex (mesmo trade-off
// já aceito em _pareceMudancaDeAssunto de vendas.flow.js).
const ESCAPE_FEEDBACK_RE =
  /^(0|menu|inicio|voltar|home|cancelar|oi|ola|opa|bom dia|boa tarde|boa noite|[1-4])$/;

function _pareceEscapeDeFeedback(message) {
  // Mesmo padrão de msgSemPontuacao em main.flow.js: remove pontuação antes
  // de comparar, pra "menu." ou "1!" também contarem como escape explícito.
  const semPontuacao = normalizar(message).replace(/[^\p{L}\p{N}\s]/gu, "").trim();
  return ESCAPE_FEEDBACK_RE.test(semPontuacao);
}

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
//
// Pedido do usuário (2026-07-30): esse valor agora é configurável na Central
// de Configurações (Atendimento humano → "Tempo de reabertura sem
// pesquisa/saudação"), não só via .env — por isso virou uma função async que
// lê settings.service (com cache de 30s, já usado pelo resto do arquivo) em
// vez de uma constante fixa calculada uma única vez no load do módulo.
async function _getReopenWindowMs() {
  const settings = await getSettings();
  const minutos = Number(settings?.atendimento?.tempoReaberturaSemPesquisa);
  return (Number.isFinite(minutos) && minutos > 0 ? minutos : 60) * 60 * 1000;
}

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
  // Pedido do usuário (2026-07-24): todo cliente que gera um ticket (novo
  // ou reaproveitado, ver bloco "ativo" logo abaixo — as duas situações
  // significam "esse cliente gerou um atendimento de verdade") deixa de ser
  // "Clientes Novos" e passa a ser "Clientes" no cadastro de contatos.
  // Roda de forma best-effort — nunca deve impedir a criação/reaproveitamento
  // do ticket em si (marcarComoCliente já trata os próprios erros por dentro,
  // nunca rejeita).
  await marcarComoCliente(userId);

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

// PEDIDO DO USUÁRIO (2026-07-27): "existem conversas que reabrem onde já
// deram nota de atendimento. Quando fecharem, a pesquisa disparará de
// novo — o cliente responde duas vezes". Isso já era resolvido pro
// reabertura AUTOMÁTICA (reopenTicketIfClosed acima, resetSatisfaction:
// false) mas não pra reabertura MANUAL (botão "Reabrir" no painel, via
// patchTicket → updateTicketStatus) — essa sempre zerava os campos de
// satisfação (resetSatisfaction:true, o padrão), então fechar de novo
// sempre disparava a pesquisa outra vez.
//
// DECISÃO (discutida com o usuário — considerei um botão manual "Fechar
// sem pesquisa" mas descartei: depende do atendente lembrar de usar o
// certo toda vez, o mesmo tipo de esquecimento que já causou outros
// problemas em produção — ver [[project-bot-rildon-bot-desligado-esquecido]]).
// Em vez disso, aplica a MESMA janela de tempo já usada pra reabertura
// automática (REOPEN_WINDOW_MS/TICKET_REOPEN_WINDOW_MINUTOS, padrão
// 60min): reabertura MANUAL de um ticket avaliado HÁ POUCO TEMPO preserva
// a nota (mesma conversa continuando); reabertura de um ticket avaliado
// há muito tempo (ou nunca avaliado) reseta normalmente — é
// provavelmente um atendimento novo e não relacionado, então merece
// pesquisa própria quando fechar de novo.
async function _deveManterSatisfacaoAoReabrir(ticketAtual) {
  if (!ticketAtual) return false;
  if (ticketAtual.status !== "resolvido") return false;
  if (!ticketAtual.satisfactionRatedAt) return false;
  const janelaMs = await _getReopenWindowMs();
  const avaliadoRecentemente =
    (Date.now() - new Date(ticketAtual.satisfactionRatedAt).getTime()) <= janelaMs;
  return avaliadoRecentemente;
}

// PEDIDO DO USUÁRIO (2026-07-27): "quando clicar em reabrir não mande a
// saudação com o nome do funcionário nem a pesquisa de satisfação por
// determinado tempo". Cobre o caso GERAL de reabertura manual (botão
// "Reabrir" em Fechados), inclusive tickets fechados/avaliados HÁ DIAS —
// diferente de _deveManterSatisfacaoAoReabrir acima, que só evita reset
// quando a nota antiga foi dada há pouco tempo (não ajuda o caso de um
// ticket avaliado há 3 dias, por exemplo). Aqui o relógio começa NO
// MOMENTO DO CLIQUE em Reabrir, não em quando foi avaliado antes — por
// isso não dá pra decidir isso só com resetSatisfaction (que só atua na
// hora de reabrir): rastreado à parte, por ticket id, com a MESMA janela
// (REOPEN_WINDOW_MS/TICKET_REOPEN_WINDOW_MINUTOS) e consultado depois, na
// hora de mandar a saudação do atendente (assumirTicket) e na hora de
// fechar de novo (patchTicket) — ver foiReabertoManualmenteRecente().
// Em memória (mesmo padrão de humanMode.service.js/dedup.js): se o
// processo reiniciar dentro da janela, pior caso é a saudação/pesquisa
// disparar de novo uma vez — não é um problema de integridade de dados.
const _reaberturaManualEm = new Map(); // ticketId (string) → timestamp (ms)

function marcarReaberturaManual(ticketId) {
  if (ticketId == null) return;
  _reaberturaManualEm.set(String(ticketId), Date.now());
}

async function foiReabertoManualmenteRecente(ticketId) {
  if (ticketId == null) return false;
  const t = _reaberturaManualEm.get(String(ticketId));
  if (!t) return false;
  const janelaMs = await _getReopenWindowMs();
  if (Date.now() - t > janelaMs) {
    _reaberturaManualEm.delete(String(ticketId));
    return false;
  }
  return true;
}

async function updateTicketStatus(id, status, { ticketAtual } = {}) {
  const foiReaberturaManual =
    status === "aberto" &&
    ticketAtual &&
    (ticketAtual.status === "resolvido" || ticketAtual.status === "cancelado");
  if (foiReaberturaManual) marcarReaberturaManual(ticketAtual.id);

  const manterSatisfacao = status === "aberto" && await _deveManterSatisfacaoAoReabrir(ticketAtual);
  return ticketRepository.updateStatus(id, status, { resetSatisfaction: !manterSatisfacao });
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
    const janelaMs = await _getReopenWindowMs();
    const fechadoRecentemente =
      latest.updatedAt && (Date.now() - new Date(latest.updatedAt).getTime()) <= janelaMs;

    if ((latest.status === "resolvido" || latest.status === "cancelado") && !fechadoRecentemente) {
      // Fechado há mais tempo que a janela — trata como se não houvesse
      // ticket reabrível. O fluxo normal segue e cria um ticket NOVO quando
      // o cliente de fato pedir algo (não força criação aqui: uma simples
      // saudação, por exemplo, não deveria virar ticket sozinha).
      _reopenCooldown.delete(userId);
      return false;
    }

    if (latest.status === "resolvido" || latest.status === "cancelado") {
      // BUG CORRIGIDO (relatado pelo usuário, 2026-07-24): "cliente fecha,
      // recebe pesquisa, manda mensagem de novo (reabre), atendente assume
      // (saudação repete), fecha de novo (pesquisa repete)". Essa reabertura
      // automática só acontece DENTRO da janela de reopen (poucos minutos/
      // hora — fechadoRecentemente acima) — é a MESMA conversa continuando,
      // não um atendimento novo. resetSatisfaction:false preserva
      // satisfaction_asked_at, que enviarSaudacaoAtendente/assumirTicket usa
      // como sinal de "ciclo recente já completo" pra pular a saudação, e
      // que o guard atômico de askSatisfaction (ticket.controller.js) já
      // usa pra não reenviar a pesquisa. Reabertura MANUAL (atendente clica
      // "Reabrir" em Fechados, ver patchTicket) continua resetando tudo
      // normalmente — ali sim pode ser um atendimento genuinamente novo.
      const reaberto = await ticketRepository.updateStatus(latest.id, "aberto", { resetSatisfaction: false });
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

  // BUG CORRIGIDO (relatado pelo usuário, 2026-07-24): cliente respondeu
  // "10" à pergunta "de 1 a 5..." e a nota foi simplesmente descartada (não
  // "virou" 5 — a regex de 1-5 rejeita "10" porque o "1" é seguido de outro
  // dígito). No Brasil "nota 10" é a forma padrão de dizer "excelente"
  // mesmo quando a escala pedida é 1-5, então tratamos 6-10 como equivalente
  // à nota máxima (5) em vez de ignorar — isso também evita reabrir o
  // ticket à toa (handleSatisfactionReply retornaria null) e disparar a
  // pesquisa de novo pro cliente ter que responder uma segunda vez.
  const notaAlta = texto.match(/(?<!\d)(?:10|[6-9])(?:\s*\/\s*10)?(?!\d)/);
  if (notaAlta) return 5;

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

  // Etapa 2 (só existe se a etapa 1 abaixo detectou nota baixa): a
  // PRÓXIMA mensagem do cliente, seja lá qual for, é o texto livre de "o
  // que podemos melhorar" — não precisa parsear nada, só sanitizar e
  // salvar. Mesmo padrão de "só a mensagem imediatamente seguinte conta"
  // já usado pra aguardandoNotaSatisfacao (ver comentário acima).
  if (session.aguardandoFeedbackSatisfacao) {
    const ticketId = session.ticketFeedbackPendente || null;

    // Cliente claramente quis sair/navegar (ver _pareceEscapeDeFeedback
    // acima) em vez de responder o que pode melhorar — limpa a flag SEM
    // salvar nada como feedback e devolve null, deixando a mensagem seguir
    // o fluxo normal (menu, IA, etc.) como se a pergunta nunca tivesse
    // interceptado.
    if (_pareceEscapeDeFeedback(message)) {
      await updateSession(
        userId,
        { aguardandoFeedbackSatisfacao: undefined, ticketFeedbackPendente: undefined },
        { skipTimer: true }
      );
      return null;
    }

    await updateSession(
      userId,
      { aguardandoFeedbackSatisfacao: undefined, ticketFeedbackPendente: undefined },
      { skipTimer: true }
    );

    let ticketAtualizado = null;
    if (ticketId) {
      try {
        ticketAtualizado = await ticketRepository.saveSatisfactionFeedback(ticketId, sanitizarTexto(message, 500));
        logger.info(`[Satisfação] Feedback registrado no ticket id=${ticketId}`);
      } catch (err) {
        logger.warn(`[Satisfação] Erro ao salvar feedback (ticket id=${ticketId}): ${err.message}`);
      }
    }

    const settings = await getSettings();
    const agradecimento =
      settings?.atendimento?.mensagemAgradecimentoPesquisa ||
      "Muito obrigado pela sua avaliação!";

    return { ticket: ticketAtualizado, rating: null, response: agradecimento };
  }

  // Etapa 1: aguardando a nota (1-5) da pesquisa.
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
  logger.info(`[Satisfação] Ticket #${pendente.protocolo} avaliado com nota ${rating}`);

  const settings = await getSettings();

  // Nota baixa: pergunta o que pode melhorar ANTES do agradecimento final,
  // em vez de agradecer direto — ver SATISFACTION_LOW_THRESHOLD acima.
  if (rating <= SATISFACTION_LOW_THRESHOLD) {
    await updateSession(
      userId,
      {
        aguardandoNotaSatisfacao: undefined,
        aguardandoFeedbackSatisfacao: true,
        ticketFeedbackPendente: atualizado.id,
      },
      { skipTimer: true }
    );
    const pedirMelhoria =
      settings?.atendimento?.mensagemPedirMelhoria ||
      "Poxa, sentimos muito! O que podemos melhorar?";
    return { ticket: atualizado, rating, response: pedirMelhoria };
  }

  await updateSession(userId, { aguardandoNotaSatisfacao: undefined }, { skipTimer: true });
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
  foiReabertoManualmenteRecente,
  assignTicket,
  transferTicket,
  getTicketStats,
  getTicketsByCPF,
  parseSatisfactionRating,
  handleSatisfactionReply,
  pareceEncerramentoPosAvaliacao
};
