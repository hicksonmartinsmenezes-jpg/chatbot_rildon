// 07-conversations.js

// ─── Estado local ─────────────────────────────────────────────────────────────
let activeTicketFilter = "pendentes";
let ticketsByUser      = {}; // userId → ticket mais recente
let humanModeUsers     = new Set(); // userIds em atendimento humano (bot pausado)
// BUG CORRIGIDO: em modo restrito (ATTENDANT_CONVERSATIONS_FULL_ACCESS=false),
// um ticket ativo assumido por OUTRO atendente some de ticketsByUser (o
// backend filtra a lista) — sem isso, o frontend não tinha como distinguir
// "sem ticket ainda" (cliente novo) de "ticket existe, mas não é meu", e
// mostrava esse cliente incorretamente em "Pendentes". O backend manda essa
// lista à parte (getTickets → hiddenActiveUserIds) pra esconder de vez.
let hiddenActiveUserIds = new Set();
// Pedido do usuário: quando um ticket é assumido/transferido/fechado por
// OUTRO atendente enquanto eu já estava com a conversa aberta na tela, a
// UI precisa travar (sem botões de ação) em vez de deixar clicar e só
// então mostrar "sem permissão". Vem do backend (getTickets →
// canManageAnyTicket) pra refletir a mesma regra que o servidor aplica
// (full access vs modo restrito), sem precisar duplicar essa lógica aqui.
let canManageAnyTicket = true;
let _searchDebounceTimer = null;

// ─── Feature: responder mensagem específica / enviar arquivo (pedido do
// usuário, 2026-07-23, "igual WhatsApp") ──────────────────────────────────
// replyingTo: { messageId, text } | null — mensagem do CLIENTE selecionada
// pra citar na próxima resposta (texto OU arquivo). Escopo: só mensagens do
// cliente podem ser citadas — mesma limitação documentada no backend
// (message.controller.js, _buscarContextoCitacao) porque uma linha do
// histórico não distingue de forma confiável o id da mensagem do cliente do
// id da mensagem do próprio atendente.
let replyingTo = null;
// pendingMediaFile: File | null — arquivo escolhido (attach/drag&drop/paste)
// aguardando confirmação; a legenda é digitada no textarea normal e o botão
// de enviar já existente passa a mandar o arquivo em vez de texto puro
// enquanto isso estiver setado (ver sendConversationMessage).
let pendingMediaFile = null;

function debouncedSearch() {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => loadConversations(), 300);
}

// ─── Filtro de status ─────────────────────────────────────────────────────────
function setTicketFilter(filter, btn) {
  activeTicketFilter = filter;
  document.querySelectorAll(".chat-status-tab").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  loadConversations();
}

// ─── Carrega conversas filtradas por status de ticket ─────────────────────────
// silent=true → atualiza sem limpar a lista (evita piscar em polls automáticos)
async function loadConversations(silent = false) {
  return runExclusive("loadConversations", () => _loadConversationsCore(silent));
}

async function _loadConversationsCore(silent = false) {
  const list   = document.getElementById("chat-list");
  const total  = document.getElementById("chat-total");
  const search = document.getElementById("search-conversations")?.value?.trim().toLowerCase() || "";

  if (!silent && list) list.innerHTML = renderSkeletonList(6);

  try {
    const [histRes, ticketRes, hmRes] = await Promise.all([
      apiFetch(`${BASE}/api/history/conversations`).catch(() => null),
      apiFetch(`${BASE}/api/tickets?limit=500`).catch(() => null),
      apiFetch(`${BASE}/api/messages/humanmode`).catch(() => null)
    ]);

    // Conjunto de clientes em atendimento humano (bot pausado)
    humanModeUsers = new Set();
    if (hmRes?.ok) {
      try { const hm = await hmRes.json(); (hm.users || []).forEach(u => humanModeUsers.add(u)); } catch (_) {}
    }

    if (!histRes?.ok) {
      if (list) list.innerHTML = `<p class="empty chat-empty">❌ Erro ao carregar conversas.</p>`;
      return;
    }

    const raw = await histRes.json();
    allHistory = Array.isArray(raw) ? raw : raw.data || [];

    // Monta mapa userId → ticket mais recente
    ticketsByUser = {};
    hiddenActiveUserIds = new Set();
    if (ticketRes?.ok) {
      const ticketData = await ticketRes.json();
      const tickets = ticketData.tickets || [];
      (ticketData.hiddenActiveUserIds || []).forEach(uid => hiddenActiveUserIds.add(uid));
      canManageAnyTicket = ticketData.canManageAnyTicket !== false;
      // Ordena: tickets ativos primeiro, depois por data DESC
      // Assim um ticket aberto/em_andamento sempre ganha sobre um resolvido mais recente
      const STATUS_PRIO = { aberto: 0, em_andamento: 1, resolvido: 2, cancelado: 3 };
      const sorted = [...tickets].sort((a, b) => {
        const sp = (STATUS_PRIO[a.status] ?? 9) - (STATUS_PRIO[b.status] ?? 9);
        if (sp !== 0) return sp;
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      for (const t of sorted) {
        if (!t.userId) continue;
        if (!ticketsByUser[t.userId]) ticketsByUser[t.userId] = t;
      }
    }

    // BUG CORRIGIDO (relatado pelo usuário): cliente com ticket fechado que
    // manda mensagem FORA da janela de reopen (TICKET_REOPEN_WINDOW_MINUTOS,
    // padrão 60min) não reabre o ticket antigo de propósito (ver comentário
    // em reopenTicketIfClosed, ticket.service.js) — o bot responde
    // normalmente, mas nenhum ticket novo é criado só por isso (uma saudação
    // não deveria virar ticket sozinha). Resultado: ticketsByUser[uid] ainda
    // aponta pro ticket ANTIGO "resolvido", e o filtro de Pendentes abaixo só
    // tratava "sem ticket" ou "aberto" como pendente — um cliente nessa
    // situação ficava com ticket fechado + conversa ativa e não aparecia em
    // NENHUMA aba visível (não é "aberto" pra Pendentes, não é "hoje... já
    // fechado de propósito" o suficiente pra ficar só em Fechados, já que
    // voltou a falar). lastMsgAtByUser + estaPendente() tratam "fechado, mas
    // cliente falou de novo depois do fechamento" igual a "sem ticket" —
    // mesma lógica que _scheduleConvReload (12-socket.js) já assumia ao
    // decidir pra qual aba trocar automaticamente, só que ali não havia essa
    // comparação de fato — trocava pra Pendentes mesmo sem o cliente
    // necessariamente aparecer lá.
    // BUG CORRIGIDO (relatado pelo usuário: "resolvidos aparecendo em
    // pendentes onde não tem mensagens novas deles"): o histórico guarda
    // TAMBÉM linhas só do bot sem mensagem nenhuma do cliente — a pergunta
    // automática da pesquisa de satisfação ("De 1 a 5...") é salva com
    // message: null e createdAt alguns milissegundos DEPOIS do
    // ticket.updatedAt (mesma transação de fechamento). Contar essa linha
    // aqui fazia TODO ticket fechado com pesquisa disparada (a maioria)
    // parecer "cliente falou de novo" e reaparecer em Pendentes pra sempre,
    // mesmo sem nenhuma mensagem nova de verdade. Só conta como atividade
    // do cliente quando a linha tem `message` de fato — e mesmo com
    // mensagem real, a RESPOSTA da própria pesquisa (ex: cliente manda "5")
    // também não conta: mesma lógica de handleSatisfactionReply
    // (message.service.js) nunca reabrir o ticket por causa da nota —
    // aqui reflete a mesma intenção, senão qualquer avaliação de 1-5
    // estrelas faria o ticket já fechado (e já avaliado) voltar pra
    // Pendentes sem nenhuma necessidade real de atendimento.
    const lastMsgAtByUser = {};
    for (const item of allHistory) {
      if (!item?.userId || !item.message || item.sector === "pesquisa_satisfacao") continue;
      const t = new Date(item.createdAt).getTime();
      if (!lastMsgAtByUser[item.userId] || t > lastMsgAtByUser[item.userId]) lastMsgAtByUser[item.userId] = t;
    }
    window._lastMsgAtByUser = lastMsgAtByUser; // usado por _scheduleConvReload em 12-socket.js

    // Pedido do usuário (2026-07-31): "remova os atendimentos de ontem que
    // estão em pendentes (sem ticket ou resolvidos), mantenha só os de hoje
    // sem mandar pesquisa de satisfação" — os dois casos abaixo ("sem
    // ticket" e "resolvido/cancelado reengajado") vinham de QUALQUER dia do
    // histórico inteiro (sem corte de data), então um cliente que só passou
    // pelo menu do bot uma vez meses atrás (sem gerar ticket) ou que reabriu
    // uma conversa fechada há dias ficava em Pendentes PARA SEMPRE. Isso é
    // puramente um filtro de exibição (não fecha ticket, não muda status,
    // não passa pelo controller) — por isso não há risco de disparar
    // pesquisa de satisfação como efeito colateral. Ticket genuinamente
    // "aberto" continua pendente independente do dia (esse não foi o caso
    // relatado, e um ticket aberto de verdade sempre precisa de ação).
    const hoje = new Date().toDateString();
    function estaPendente(uid) {
      const t = ticketsByUser[uid];
      const lastMsg = lastMsgAtByUser[uid];
      const ehDeHoje = !!(lastMsg && new Date(lastMsg).toDateString() === hoje);
      if (!t) return ehDeHoje;
      if (t.status === "aberto") return true;
      if (t.status === "resolvido" || t.status === "cancelado") {
        return !!(lastMsg && t.updatedAt && lastMsg > new Date(t.updatedAt).getTime() && ehDeHoje);
      }
      return false;
    }
    window.estaPendente = estaPendente; // usado por _scheduleConvReload em 12-socket.js

    // BUG CORRIGIDO DE VEZ (relatado pelo usuário 2026-08-17: "painel mostra
    // 44 notificações porém existe apenas uma única mensagem nova"):
    // unreadMessages é um contador que só SOBE (nova_mensagem, 12-socket.js)
    // e que antes só era zerado em 3 pontos específicos — abrir a conversa
    // (openConversation), ticket fechar via socket, e o caso "resolvido +
    // não pendente" aqui embaixo. Nenhum desses cobria o caso mais comum de
    // acúmulo: um ticket que sai da janela de /api/tickets?limit=500 (fica
    // "velho demais" pra aparecer na lista) ou nunca virou ticket e a
    // mensagem já não é de hoje — esse uid nunca mais batia em NENHUM dos 3
    // casos, então o número ficava ali pra sempre, persistido no
    // localStorage, só crescendo dia após dia até virar um número sem
    // relação nenhuma com o que está pendente de verdade.
    //
    // Correção definitiva: em vez de tentar prever caso a caso quando zerar,
    // a cada carregamento o contador é reconciliado contra o universo de
    // contatos que ainda fazem sentido — ticket meu genuinamente ativo
    // (aberto, ou em_andamento e visível pra mim) OU contato que falou HOJE
    // e ainda não tem ticket. Qualquer não-lida fora desse universo é lixo
    // acumulado (ticket antigo já fechado/fora da janela carregada, ou
    // ticket em_andamento de OUTRO atendente que ficou oculto pra mim) — é
    // removida do contador, não só zerada. Como isso roda em todo reload
    // (poll e cada nova_mensagem via _scheduleConvReload), o contador nunca
    // mais consegue acumular lixo por mais que alguns segundos.
    const universoNaoLidaValido = new Set();
    for (const [uid, t] of Object.entries(ticketsByUser)) {
      if ((t.status === "aberto" || t.status === "em_andamento") && !hiddenActiveUserIds.has(uid)) {
        universoNaoLidaValido.add(uid);
      }
    }
    for (const uid of Object.keys(lastMsgAtByUser)) {
      if (new Date(lastMsgAtByUser[uid]).toDateString() === hoje) universoNaoLidaValido.add(uid);
    }
    let _unreadLimpo = false;
    for (const uid of Object.keys(unreadMessages)) {
      if (!unreadMessages[uid]) continue;
      if (!universoNaoLidaValido.has(uid)) {
        delete unreadMessages[uid];
        _unreadLimpo = true;
      }
    }
    if (_unreadLimpo) {
      updateSidebarUnreadBadge();
      persistUnreadMessages();
    }

    // Atualiza badges de contagem — oculta quando zero
    //
    // BUG CORRIGIDO (relatado pelo usuário: "diz 16 pendentes mas só tem 10
    // na lista"): em modo restrito (ATTENDANT_CONVERSATIONS_FULL_ACCESS=false),
    // o backend some do array `tickets` os tickets em_andamento ASSUMIDOS por
    // OUTRO atendente/setor (ver hiddenActiveUserIds, ticket.controller.js) —
    // então esses userIds nunca entram em ticketsByUser aqui. O 2º termo
    // abaixo (usuários "sem ticket" que têm mensagem real no histórico) não
    // sabia distinguir "cliente novo, realmente sem ticket" de "tem ticket
    // em_andamento, só que é de outro atendente e foi ocultado" — os dois
    // casos batem em "!ticketsByUser[uid]" igual, e o segundo contava como
    // Pendente incorretamente (não é pendente, já está sendo atendido, só
    // não é visível PRA MIM). A lista realmente exibida já excluía esses
    // usuários via hiddenActiveUserIds (linha abaixo, "usersSeen") — o badge
    // não aplicava esse mesmo filtro. Agora aplica.
    const pendentes   = Object.keys(ticketsByUser).filter(uid => estaPendente(uid)).length
      + Object.keys(lastMsgAtByUser).filter(uid => !ticketsByUser[uid] && !hiddenActiveUserIds.has(uid) && new Date(lastMsgAtByUser[uid]).toDateString() === hoje).length;
    const emAndamento = Object.values(ticketsByUser).filter(t => t.status === "em_andamento").length;
    const badgeP = document.getElementById("badge-pendentes");
    const badgeA = document.getElementById("badge-em_andamento");
    if (badgeP) {
      badgeP.textContent = pendentes;
      badgeP.style.display = pendentes > 0 ? "" : "none";
    }
    if (badgeA) {
      badgeA.textContent = emAndamento;
      badgeA.style.display = emAndamento > 0 ? "" : "none";
    }

    if (!list) return;

    // Coleta usuários únicos do histórico
    const usersSeen = new Set();
    let users = [];
    for (const item of allHistory) {
      if (item?.userId && !usersSeen.has(item.userId) && !hiddenActiveUserIds.has(item.userId)) {
        usersSeen.add(item.userId);
        users.push(item.userId);
      }
    }

    // Filtra por status de ticket conforme aba ativa
    if (activeTicketFilter === "pendentes") {
      // Sem ticket = cliente novo ainda no menu do bot → também aparece em
      // Pendentes. Ticket fechado + cliente falou de novo depois = mesma
      // situação (ver BUG CORRIGIDO acima) — estaPendente() cobre os dois.
      users = users.filter(uid => estaPendente(uid));
    } else if (activeTicketFilter === "em_andamento") {
      users = users.filter(uid => ticketsByUser[uid]?.status === "em_andamento");
    } else if (activeTicketFilter === "fechados") {
      // `hoje` já declarado acima (usado também por estaPendente/badge).
      users = users.filter(uid => {
        const t = ticketsByUser[uid];
        if (!t) return false;
        if (t.status !== "resolvido" && t.status !== "cancelado") return false;
        // Reativado (cliente falou de novo depois de fechado) já foi pra
        // Pendentes acima — não duplica aqui.
        if (estaPendente(uid)) return false;
        return t.updatedAt && new Date(t.updatedAt).toDateString() === hoje;
      });
    }
    // "todos" → sem filtro adicional

    // Filtra por busca — índice pré-calculado para evitar O(n²)
    if (search) {
      const idx = {};
      for (const item of allHistory) {
        if (!item?.userId) continue;
        if (!idx[item.userId]) idx[item.userId] = `${contactLabel(item.userId)} ${formatPhone(item.userId)} `.toLowerCase();
        idx[item.userId] += `${item.contactName || ""} ${item.message || ""} ${item.response || ""} ${item.sector || ""} `.toLowerCase();
      }
      users = users.filter(uid => (idx[uid] || "").includes(search));
    }

    // Ordena por última atividade
    users.sort((a, b) => {
      const aLast = getLastHistoryItem(a);
      const bLast = getLastHistoryItem(b);
      return new Date(bLast?.createdAt || 0) - new Date(aLast?.createdAt || 0);
    });

    if (total) {
      total.textContent = `${users.length} ${users.length === 1 ? "conversa" : "conversas"}`;
    }

    if (!users.length) {
      list.innerHTML = `<p class="empty chat-empty">Nenhuma conversa encontrada.</p>`;
      return;
    }

    list.innerHTML = users.map(userId => {
      const last    = getLastHistoryItem(userId);
      const name    = getContactName(userId) || formatPhone(userId);
      const preview = lastMessage(userId);
      const unread  = unreadMessages[userId] || 0;
      const time    = shortTime(last?.createdAt);
      const ticket  = ticketsByUser[userId];
      const ticketStatus = String(ticket?.status || "").replace(/[^a-z0-9_-]/gi, "");
      const statusPill = ticket
        ? `<span class="conv-status-pill status-${ticketStatus}">${safe(statusLabel(ticket.status))}</span>`
        : "";
      const statusClass = ticketStatus ? `ci-status-${ticketStatus}` : "";
      // Pedido do usuário: badge sempre verde (igual ao WhatsApp), sem variar
      // por status do ticket — a cor por status é o que causava o badge
      // laranja/azul/vermelho ilegível antes.
      const unreadLabel = unread > 99 ? "99+" : unread; // igual ao badge da sidebar (updateSidebarUnreadBadge)

      return `
        <button type="button" class="chat-item ${statusClass}" data-user="${escapeAttr(userId)}" data-conv-list-action="open">
          ${avatarHtml(userId, name)}
          <span class="chat-item-body">
            <span class="chat-item-top">
              <strong>${safe(name)}</strong>
              <small>${safe(time)}</small>
            </span>
            <span class="chat-item-bottom">
              <span>${safe(preview)}</span>
              ${unread > 0 ? `<span class="chat-unread">${unreadLabel}</span>` : ""}
            </span>
            ${statusPill ? `<span class="chat-item-row3">${statusPill}</span>` : ""}
          </span>
        </button>
      `;
    }).join("");
    bindConversationListDelegation();
    if (!silent) applyStaggerIn(list);

    // Reabre o painel da conversa selecionada sempre que ela ainda existe no
    // histórico (usersSeen = superset ANTES do filtro de aba/busca), não só
    // quando ela sobrevive ao filtro da aba atual. Antes disso, fechar um
    // ticket na aba "Ativos" fazia o usuário sumir de `users` (ticket virou
    // "resolvido", não bate mais no filtro em_andamento/aberto) e o painel
    // da direita ficava com o header/botões antigos ("Transferir"/"Fechar"),
    // parecendo que o fechamento não tinha efeito nenhum — mesmo o backend
    // já tendo fechado o ticket com sucesso.
    if (selectedConversationUser && usersSeen.has(selectedConversationUser)) {
      openConversation(selectedConversationUser, true);
    }

  } catch (err) {
    console.error("Erro ao carregar conversas:", err);
    if (list) list.innerHTML = `<p class="empty chat-empty">❌ Erro ao carregar conversas.</p>`;
  }
}

function bindConversationListDelegation() {
  const list = document.getElementById("chat-list");
  if (!list || list.dataset.delegated === "true") return;
  list.dataset.delegated = "true";

  list.addEventListener("click", (event) => {
    const item = event.target.closest("[data-conv-list-action='open']");
    if (!item || !list.contains(item)) return;
    const userId = item.dataset.user;
    if (userId) openConversation(userId);
  });
}

// getLastHistoryItem extraído para js/conversations/conversations-utils.js

// lastMessage extraído para js/conversations/conversations-utils.js

// Pedido do usuário (2026-07-20): "verifique por que arquivos de mídia e
// áudio não aparecem no meu painel". O backend agora salva o arquivo (ver
// migration 017) e serve de volta por GET /api/history/media/:id
// (autenticado — mesma sessão do painel). Escolhe a tag certa pelo prefixo
// do mimetype; documento (ou mimetype desconhecido) vira link de download.
function renderMediaBubble(item) {
  if (!item.mediaPath || !item.id) return "";

  const url = `${BASE}/api/history/media/${item.id}`;
  const mime = item.mediaMimetype || "";

  if (mime.startsWith("image/")) {
    return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener"><img class="chat-media chat-media-image" src="${escapeAttr(url)}" alt="Imagem enviada pelo cliente" loading="lazy"></a>`;
  }
  if (mime.startsWith("audio/")) {
    return `<audio class="chat-media chat-media-audio" controls preload="none" src="${escapeAttr(url)}"></audio>`;
  }
  if (mime.startsWith("video/")) {
    return `<video class="chat-media chat-media-video" controls preload="none" src="${escapeAttr(url)}"></video>`;
  }
  const nomeArquivo = item.mediaFilename || "arquivo";
  return `
    <a class="chat-media chat-media-file" href="${escapeAttr(url)}" target="_blank" rel="noopener">
      <i class="fa-solid fa-paperclip"></i> ${safe(nomeArquivo)}
    </a>
  `;
}

async function openConversation(userId, updateActive = true) {
  _openConvAbort?.abort();
  _openConvAbort = new AbortController();
  const seq = ++_openConvSeq;

  // BUG CORRIGIDO (pedido do usuário: "sempre que chega mensagem nova o
  // painel...rola tela de mensagens para baixo"): essa função também é
  // chamada pelo socket (12-socket.js, evento nova_mensagem) toda vez que
  // chega mensagem nova NA CONVERSA JÁ ABERTA, pra mesclar o histórico —
  // e o final da função sempre forçava `scrollTop = scrollHeight`
  // (rolar pro final), mesmo se o atendente estivesse propositalmente
  // com a rolagem pra cima lendo mensagens antigas. Agora só força ir pro
  // final quando: (a) é uma conversa DIFERENTE sendo aberta agora (troca
  // de conversa — comportamento esperado, sempre começa do final), ou (b)
  // é a mesma conversa mas o atendente já estava perto do final (segue a
  // conversa "ao vivo", igual WhatsApp/Slack). Se estava lendo mais pra
  // cima, a posição de leitura é preservada.
  const eraMesmaConversaJaAberta = selectedConversationUser === userId;
  const messagesBoxAntes = document.getElementById("chat-messages");
  const distanciaDoFinalAntes = messagesBoxAntes
    ? messagesBoxAntes.scrollHeight - messagesBoxAntes.scrollTop - messagesBoxAntes.clientHeight
    : 0;
  const deveAcompanharFinal = !eraMesmaConversaJaAberta || distanciaDoFinalAntes < 150;

  // Troca de conversa: nenhuma citação/arquivo pendente da conversa anterior
  // deve "vazar" pra essa (ex: responder sem querer uma mensagem de outro
  // cliente porque esqueceu de cancelar antes de trocar de aba).
  if (selectedConversationUser !== userId) {
    replyingTo = null;
    pendingMediaFile = null;
  }

  selectedConversationUser = userId;

  // Pedido do usuário: no celular a lista de conversas e a janela de chat
  // não cabem lado a lado — essa classe faz a tela trocar pra mostrar só
  // o chat (a lista some) quando uma conversa é aberta; o botão de voltar
  // no cabeçalho (closeMobileChat) desfaz isso. Em telas largas essa
  // classe não tem efeito (ver @media em 06-conversations.css).
  document.querySelector(".whatsapp-panel")?.classList.add("mobile-conv-open");

  const textarea = document.getElementById("conversation-message");
  const hadUnread = unreadMessages[userId] > 0;
  unreadMessages[userId] = 0;
  updateSidebarUnreadBadge();
  persistUnreadMessages();

  if (hadUnread && updateActive) {
    setTimeout(() => loadConversations(), 100);
  }

  const header      = document.getElementById("chat-window-header");
  const messagesBox = document.getElementById("chat-messages");

  // Ticket pertence a outro atendente (modo restrito) → trava a conversa:
  // sem botões de ação e sem poder enviar mensagem, só visualização.
  //
  // BUG CORRIGIDO: só deve travar quando o ticket está ATIVO (em_andamento)
  // com outro dono — fechar() não limpa assigned_to, então um ticket
  // "resolvido" continua marcado com quem o fechou por último, e isso
  // travava a conversa (input desabilitado, sem ações) mesmo já podendo
  // reabrir/fechar de novo (canManageTicket libera aberto/resolvido/
  // cancelado pra qualquer atendente). Ver mesma correção em
  // conversations-render.js (buildConversationActionButtons).
  const _ticketAtual = ticketsByUser[userId];
  const _locked = !canManageAnyTicket && Boolean(
    _ticketAtual?.status === "em_andamento" &&
    _ticketAtual?.assignedTo && getCurrentUser()?.id &&
    String(_ticketAtual.assignedTo) !== String(getCurrentUser().id)
  );
  const _lockedName = _ticketAtual?.assignedToName || "outro atendente";

  if (textarea) {
    textarea.disabled = _locked;
    textarea.placeholder = _locked
      ? `Assumido por ${_lockedName} — sem ações disponíveis`
      : "Digite uma mensagem...";
  }

  const attachBtn = document.getElementById("btn-attach-conversation");
  if (attachBtn) attachBtn.disabled = _locked;

  renderReplyPreviewBar();
  renderMediaPreviewBar();

  if (header) {
    const name     = getContactName(userId) || formatPhone(userId);
    const ticket   = ticketsByUser[userId];

    const actionButtons = buildConversationActionButtons(userId, ticket, humanModeUsers, {
      currentUserId: getCurrentUser()?.id,
      fullAccess: canManageAnyTicket
    });

    // BUG CORRIGIDO (pedido do usuário: "consegue dar uma organizada
    // melhor nisso?"): o header empilhava até 4 linhas, com informação
    // repetida — "Assumido por X" (chat-ticket-ref) e logo abaixo "X
    // atendendo · bot pausado" (chat-bot-paused) dizem exatamente a mesma
    // coisa duas vezes. Agora é uma linha só: protocolo+setor, depois UMA
    // linha de status (quem está atendendo + bot pausado, quando aplicável)
    // — nunca as duas juntas.
    const statusLine = humanModeUsers.has(userId)
      ? `<span class="chat-bot-paused"><i class="fa-solid fa-headset"></i> ${_locked ? safe(_lockedName) : "Você"} atendendo · bot pausado</span>`
      : (ticket?.status === "em_andamento" && ticket.assignedToName
          ? `<span class="chat-ticket-ref"><i class="fa-solid fa-user-check"></i> Assumido por ${safe(ticket.assignedToName)}</span>`
          : "");

    header.innerHTML = `
      <button type="button" class="chat-mobile-back" data-action="closeMobileChat" title="Voltar para a lista">
        <i class="fa-solid fa-arrow-left"></i>
      </button>
      <div class="chat-header-profile">
        ${avatarHtml(userId, name, true)}
        <div class="chat-header-info">
          <strong class="chat-contact-name">${safe(name)}</strong>
          ${ticket ? `<span class="chat-ticket-ref">#${safe(ticket.protocolo || ticket.id)} · ${safe(ticket.sector || "geral")}</span>` : ""}
          ${statusLine}
          <div id="chat-typing-status"></div>
        </div>
      </div>
      <div class="chat-header-actions">
        ${actionButtons}
      </div>
    `;
    bindConversationHeaderDelegation();
  }

  if (updateActive) {
    document.querySelectorAll(".chat-item").forEach(item => item.classList.remove("active"));
    document.querySelector(`.chat-item[data-user="${cssEscape(userId)}"]`)?.classList.add("active");
  }

  // Filtro solicitado pelo usuário ("filtro de borrão"): conversa de outro
  // atendente não deve nem buscar nem renderizar o histórico de mensagens —
  // mostra só um aviso de bloqueio, sem o conteúdo real chegar ao DOM.
  if (messagesBox && _locked) {
    messagesBox.innerHTML = `
      <div class="chat-locked-banner">
        <i class="fa-solid fa-lock"></i>
        <strong>Conversa assumida por ${safe(_lockedName)}</strong>
        <span>Sem acesso ao histórico nem ao envio de mensagens aqui.</span>
      </div>
    `;
    return;
  }

  // Busca histórico completo do usuário via API para exibir todas as mensagens
  let userHistory = allHistory.filter(item => item.userId === userId);
  try {
    const r = await apiFetch(`${BASE}/api/history?userId=${encodeURIComponent(userId)}&limit=500`, { signal: _openConvAbort.signal });
    if (seq !== _openConvSeq) return; // chamada mais nova já assumiu o controle
    if (r?.ok) {
      const raw = await r.json();
      const rows = Array.isArray(raw) ? raw : raw.data || [];
      if (rows.length) userHistory = rows;
    }
  } catch (_) {}

  if (seq !== _openConvSeq) return; // verificação final antes de renderizar

  const messages = [...userHistory].reverse();

  if (!messagesBox) return;

  if (!messages.length) {
    messagesBox.innerHTML = `<p class="empty chat-empty">Nenhuma mensagem encontrada.</p>`;
    return;
  }

  let lastDay = "";
  const html  = [];

  for (const item of messages) {
    const currentDay = dayLabel(item.createdAt);
    if (currentDay !== lastDay) {
      html.push(`<div class="day-separator"><span>${safe(currentDay)}</span></div>`);
      lastDay = currentDay;
    }
    // BUG CORRIGIDO (achado na sessão de testes, 2026-07-23): a condição
    // antiga (`item.message || item.mediaPath`) fazia QUALQUER linha com
    // mediaPath renderizar do lado do CLIENTE, mesmo quando a mídia foi
    // enviada pelo ATENDENTE (feature de enviar arquivo — mediaPath +
    // response, message sempre null nesse caso). Resultado: arquivo/foto
    // enviado pelo atendente aparecia DUAS VEZES — uma à esquerda (errado)
    // e uma à direita (certo, no bloco de baixo) — sempre, com ou sem
    // legenda, já que `response` nunca fica null pro atendente (com
    // legenda usa o texto digitado; sem legenda usa o fallback "[arquivo
    // enviado]" do fix anterior). Mídia recebida do cliente sempre grava
    // um rótulo em `message` (ex: "[imagem recebido]"), então checar só
    // `item.message` já cobre os dois casos reais de mídia do cliente sem
    // duplicar a do atendente.
    if (item.message) {
      // Feature: responder mensagem específica (pedido do usuário,
      // 2026-07-23). Só mensagem de TEXTO do cliente pode ser citada — mesmo
      // escopo do backend (message.controller.js, _buscarContextoCitacao):
      // uma linha do histórico não distingue com segurança o id da mensagem
      // do cliente do id da mensagem do próprio atendente, então citar uma
      // mensagem de mídia (sem texto) ou sem messageId ficaria ambíguo.
      //
      // PEDIDO DO USUÁRIO (2026-08-14): não tratar o rótulo interno de mídia
      // sem legenda ("[imagem recebida]", "[sticker recebido]" etc. — ver
      // isMediaPlaceholderLabel em conversations-utils.js) como texto de
      // verdade — nem pra exibir (a mídia já aparece no balão logo acima),
      // nem pra oferecer resposta/citação em cima dele.
      const ehPlaceholderMidia = isMediaPlaceholderLabel(item.message);
      const podeResponder = Boolean(item.message && item.messageId && !ehPlaceholderMidia);
      const replyBtn = podeResponder
        ? `<button type="button" class="bubble-reply-btn" data-reply-msg-id="${escapeAttr(item.messageId)}" data-reply-text="${escapeAttr(item.message.slice(0, 300))}" title="Responder"><i class="fa-solid fa-reply"></i></button>`
        : "";
      html.push(`
        <div class="bubble-row client-row">
          <div class="bubble client">
            ${replyBtn}
            ${renderMediaBubble(item)}
            ${item.message && !ehPlaceholderMidia ? `<p>${safe(item.message)}</p>` : ""}
            <small>${safe(shortTime(item.createdAt))}</small>
          </div>
        </div>
      `);
    }
    if (item.response) {
      // Prévia da mensagem citada (reply/quote) — mesmo visual do WhatsApp,
      // uma faixa acima do texto respondido. Só existe quando esta resposta
      // foi enviada com quotedMessageId (ver migration 019 e
      // src/config/whatsapp.js, _buildQuotedMessage).
      const quoteStrip = item.quotedText
        ? `<div class="bubble-quote"><i class="fa-solid fa-reply"></i> ${safe(item.quotedText.slice(0, 160))}</div>`
        : "";
      html.push(`
        <div class="bubble-row bot-row">
          <div class="bubble bot"${item.messageId ? ` data-msg-id="${escapeAttr(item.messageId)}"` : ""}>
            ${quoteStrip}
            ${renderMediaBubble(item)}
            ${item.response ? `<p>${safe(item.response)}</p>` : ""}
            <small>${safe(shortTime(item.createdAt))} <span class="msg-status">${renderMessageStatus(item.status)}</span></small>
          </div>
        </div>
      `);
    }
  }

  messagesBox.innerHTML = html.join("");
  bindConversationMessagesDelegation();
  // Aguarda render antes de rolar para garantir altura correta
  requestAnimationFrame(() => {
    if (deveAcompanharFinal) {
      messagesBox.scrollTop = messagesBox.scrollHeight;
    } else {
      // Preserva a posição de leitura: mantém a mesma distância (em px) até
      // o final que já existia antes do re-render, em vez de resetar pro topo
      // (padrão do navegador ao trocar innerHTML) ou forçar pro final.
      messagesBox.scrollTop = messagesBox.scrollHeight - messagesBox.clientHeight - distanciaDoFinalAntes;
    }
  });
}

// ─── Navegação mobile (lista ↔ chat) ─────────────────────────────────────────
function closeMobileChat() {
  document.querySelector(".whatsapp-panel")?.classList.remove("mobile-conv-open");
  // BUG CORRIGIDO (pedido do usuário, 2026-07-22): sem isso, selectedConversationUser
  // continuava setado depois de "voltar" — na próxima vez que loadConversations()
  // rodasse (ex: clicar em Pendentes/Ativos/Fechados), o auto-reselect de
  // _loadConversationsCore (linha ~231, "selectedConversationUser && usersSeen.has(...)")
  // reabria a MESMA conversa sozinho, como se o botão de voltar não tivesse feito nada.
  selectedConversationUser = null;
}

// ─── Devolver atendimento ao bot ─────────────────────────────────────────────
async function releaseToBot(userId) {
  try {
    const res = await apiFetch(`${BASE}/api/messages/humanmode/release`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId })
    });
    if (!res?.ok) throw new Error("falhou");
    humanModeUsers.delete(userId);
    showToast("🤖 Bot reativado para este cliente.");
    await loadConversations();
    if (selectedConversationUser) openConversation(selectedConversationUser);
  } catch (_) {
    showToast("❌ Não consegui devolver ao bot.");
  }
}

// ─── Ações de ticket na conversa ─────────────────────────────────────────────
function bindConversationHeaderDelegation() {
  const header = document.getElementById("chat-window-header");
  if (!header || header.dataset.delegated === "true") return;
  header.dataset.delegated = "true";

  header.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-conv-action]");
    if (!btn || !header.contains(btn)) return;

    const action = btn.dataset.convAction;
    const ticketId = btn.dataset.ticketId;
    const userId = btn.dataset.userId;

    if (action === "aceitar" && ticketId) return aceitarTicketConv(ticketId);
    if (action === "transferir" && ticketId) return transferirTicketConv(ticketId);
    if (action === "fechar" && ticketId) return fecharTicketConv(ticketId);
    if (action === "reabrir" && userId) return reabrirTicketConv(userId);
    if (action === "release-bot" && userId) return releaseToBot(userId);
  });
}

async function aceitarTicketConv(id) {
  try {
    const res = await apiFetch(`${BASE}/api/tickets/${id}/assign`, { method: "PATCH" });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao aceitar.");
    showToast("✅ Ticket aceito!");
    await loadConversations();
    if (selectedConversationUser) openConversation(selectedConversationUser);
    if (currentTab === "metrics") loadMetricsCharts();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function reabrirTicketConv(userId) {
  try {
    const ticket = ticketsByUser[userId];
    let mensagemSucesso = "✅ Atendimento reaberto!";

    if (ticket) {
      // Reabre ticket existente
      const res = await apiFetch(`${BASE}/api/tickets/${ticket.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ status: "aberto" })
      });
      if (!res) return;
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // BUG CORRIGIDO (relatado pelo usuário): "Reabrir" em Fechados podia
        // aparecer pra um cliente que JÁ está ativo com outro atendente
        // (dado desatualizado no navegador) — clicar "roubava" o cliente,
        // criando dois tickets conflitantes. O backend agora bloqueia isso
        // (409, ticket.controller.js), mas antes o toast só mostrava "Erro
        // ao reabrir" genérico, sem dizer o motivo real. Agora mostra a
        // mensagem específica do backend (ex: "já está em atendimento
        // ativo com Fulano") e recarrega a lista pra corrigir o dado
        // desatualizado que causou o clique errado.
        await loadConversations();
        throw new Error(data.error || "Erro ao reabrir.");
      }
    } else {
      // Cria novo ticket se não existir nenhum
      const res = await apiFetch(`${BASE}/api/tickets`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId, type: "geral", sector: "geral" })
      });
      if (!res?.ok) throw new Error("Erro ao criar atendimento.");

      // Pedido do usuário (2026-08-05): "quem clicar em iniciar atendimento,
      // automaticamente já aceita e vai para ativos" — antes o botão só
      // criava o ticket em "aberto" (Pendentes), exigindo um 2º clique em
      // "Aceitar" pra virar Ativos. Reaproveita o MESMO endpoint que o botão
      // Aceitar usa (PATCH .../assign), pra ganhar os mesmos efeitos
      // colaterais dele (saudação do atendente pro cliente, assumed_at pra
      // métrica de TME, socket) em vez de duplicar essa lógica aqui.
      const data = await res.json().catch(() => ({}));
      const novoTicketId = data?.ticket?.id;
      if (novoTicketId) {
        const assignRes = await apiFetch(`${BASE}/api/tickets/${novoTicketId}/assign`, { method: "PATCH" });
        if (!assignRes?.ok) {
          // Não é erro fatal — o ticket já existe, só ficou em Pendentes
          // esperando um "Aceitar" manual em vez de ir direto pra Ativos.
          showToast("⚠️ Atendimento criado, mas não foi possível aceitar automaticamente.");
          await loadConversations();
          openConversation(userId);
          return;
        }
      }
      mensagemSucesso = "✅ Atendimento iniciado!";
    }

    showToast(mensagemSucesso);
    await loadConversations();
    openConversation(userId);
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function fecharTicketConv(id) {
  showConfirmModal({
    title:       "Fechar atendimento",
    message:     "Deseja fechar este atendimento? O ticket será marcado como resolvido.",
    confirmText: "Fechar",
    danger:      false,
    // BUG CORRIGIDO (relatado pelo usuário): este botão de fechar (tela de
    // conversa) é um caminho de código SEPARADO do botão "Resolvido" da
    // lista de tickets (06-tickets.js) — cada um disparava seu próprio
    // PATCH sem nenhuma trava. runExclusive com a MESMA chave usada lá
    // (`mudarStatus:${id}`) faz os dois caminhos dedup entre si: clicar
    // fechar na conversa E na lista pro mesmo ticket, ou clicar 2x rápido
    // aqui, reaproveita a mesma requisição em voo em vez de disparar outra.
    onConfirm:   async () => runExclusive(`mudarStatus:${id}`, async () => {
      try {
        const res = await apiFetch(`${BASE}/api/tickets/${id}`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ status: "resolvido" })
        });
        if (!res) return;
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Erro ao fechar (HTTP ${res.status}).`);
        }
        showToast("✅ Atendimento fechado!");
        fecharChat();
        await loadConversations();
        if (currentTab === "metrics") loadMetricsCharts();
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    })
  });
}

async function transferirTicketConv(id) {
  try {
    const r     = await apiFetch(`${BASE}/api/atendentes`);
    const users = r?.ok ? await r.json() : [];

    if (!users.length) {
      showToast("❌ Nenhum atendente cadastrado encontrado.");
      return;
    }

    const options = users.map(u => ({
      value: u.id,
      label: `${u.nome} (${u.perfil}${u.sector && u.sector !== "geral" ? " · " + u.sector : ""})`
    }));

    showSelectModal({
      title:       "Transferir atendimento",
      label:       "Para qual atendente?",
      options,
      confirmText: "Transferir",
      onConfirm:   async (toUserId) => {
        try {
          const res = await apiFetch(`${BASE}/api/tickets/${id}/transfer`, {
            method:  "PATCH",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ toUserId })
          });
          if (!res) return;
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Erro ao transferir (HTTP ${res.status}).`);
          }
          showToast("✅ Transferido!");
          await loadConversations();
          if (selectedConversationUser) openConversation(selectedConversationUser);
          if (currentTab === "metrics") loadMetricsCharts();
        } catch (err) {
          showToast(`❌ ${err.message}`);
        }
      }
    });
  } catch (err) {
    showToast(`❌ Erro ao carregar atendentes.`);
  }
}

// ─── Envio de mensagem ────────────────────────────────────────────────────────
function handleConversationKeydown(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendConversationMessage();
  }
}

async function sendConversationMessage() {
  if (sendingConversationMessage) return;

  // Feature: enviar arquivo igual WhatsApp (pedido do usuário, 2026-07-23) —
  // enquanto houver um arquivo escolhido (attach/drag&drop/paste), o mesmo
  // botão/atalho de enviar manda o arquivo (com o texto do textarea como
  // legenda) em vez de mensagem de texto pura.
  if (pendingMediaFile) return sendPendingMedia();

  const input   = document.getElementById("conversation-message");
  const message = input?.value?.trim();

  if (!message || !selectedConversationUser) {
    showToast("Selecione uma conversa e digite uma mensagem.");
    return;
  }

  if (message.length > 4096) {
    showToast("❌ Mensagem muito longa (máx. 4096 caracteres).");
    return;
  }

  sendingConversationMessage = true;

  // Desabilita botão de envio visualmente durante a requisição, com
  // spinner no lugar do ícone (pedido do usuário: estado de progresso
  // visível em elementos interativos).
  const sendBtn = document.getElementById("btn-send-conversation");
  const sendBtnIcon = sendBtn?.querySelector("i");
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.setAttribute("aria-busy", "true");
  }
  if (sendBtnIcon) sendBtnIcon.className = "fa-solid fa-circle-notch fa-spin";

  const found = quickRepliesCache.find(reply =>
    reply.shortcut.toLowerCase() === message.toLowerCase()
  );
  const finalMessage = found ? found.message : message;

  // Feature: responder mensagem específica (pedido do usuário, 2026-07-23).
  // Captura ANTES de limpar o estado — se a requisição falhar, replyingTo
  // não deve ter sido descartado (usuário ainda quer responder a mesma msg).
  const quotedMessageId = replyingTo?.messageId || null;

  input.value = "";
  resetTextareaHeight(input);

  // Typing indicator: fire-and-forget — falha aqui nunca bloqueia o envio
  fetch(`${BASE}/api/messages/typing`, {
    credentials: "include",
    method:  "POST",
    headers: apiHeaders(),
    body:    JSON.stringify({ userId: selectedConversationUser })
  }).catch(() => {});

  try {
    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        userId: selectedConversationUser,
        message: finalMessage,
        ...(quotedMessageId ? { quotedMessageId } : {})
      })
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");
    // Só limpa a citação depois do envio confirmado.
    if (quotedMessageId && replyingTo?.messageId === quotedMessageId) cancelReplyTo();
    // Atendente respondeu → bot pausado para este cliente (atualização otimista da UI)
    if (selectedConversationUser) humanModeUsers.add(selectedConversationUser);
    // O evento socket nova_mensagem disparado pelo backend já atualiza a conversa.
    // Só recarregamos se o socket não estiver conectado (fallback).
    if (!socket?.connected) {
      await loadHistory(false);
      await loadConversations();
      if (selectedConversationUser) openConversation(selectedConversationUser);
    }

  } catch (err) {
    showToast(`❌ Erro ao enviar: ${err.message}`);
    // Só restaura se o usuário não digitou nada novo enquanto aguardava
    if (input && !input.value.trim()) input.value = finalMessage;
  } finally {
    sendingConversationMessage = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.removeAttribute("aria-busy"); }
    if (sendBtnIcon) sendBtnIcon.className = "fa-solid fa-paper-plane";
  }
}

// ─── Feature: enviar arquivo (foto/vídeo/doc) igual WhatsApp ────────────────
// Pedido do usuário (2026-07-23): "preciso da possibilidade de poder enviar
// arquivo exatamente igual whatsapp (video, foto, doc)". Escolha do arquivo
// via botão de anexo, drag&drop na janela da conversa, ou colar (Ctrl+V) —
// ver initConversationMediaEvents(). Envia pra POST /api/messages/send-media
// (multipart/form-data — apiFetch já trata isso automaticamente, ver
// apiHeaders() em 02-auth.js).
function openConversationFilePicker() {
  document.getElementById("conversation-file-input")?.click();
}

function handleConversationFileInput(event) {
  const file = event.target?.files?.[0];
  if (file) setPendingMediaFile(file);
  // Limpa o value pra permitir escolher o MESMO arquivo de novo depois de
  // cancelar (input file não dispara "change" se o valor não mudar).
  event.target.value = "";
}

function setPendingMediaFile(file) {
  if (!selectedConversationUser) {
    showToast("Selecione uma conversa antes de anexar um arquivo.");
    return;
  }
  pendingMediaFile = file;
  renderMediaPreviewBar();
  document.getElementById("conversation-message")?.focus();
}

function cancelMediaSelection() {
  pendingMediaFile = null;
  renderMediaPreviewBar();
}

function _formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMediaPreviewBar() {
  const bar   = document.getElementById("media-preview-bar");
  const thumb = document.getElementById("media-preview-thumb");
  const name  = document.getElementById("media-preview-filename");
  const size  = document.getElementById("media-preview-filesize");
  if (!bar) return;

  if (!pendingMediaFile) {
    bar.classList.add("hidden");
    if (thumb) thumb.innerHTML = "";
    return;
  }

  bar.classList.remove("hidden");
  if (name) name.textContent = pendingMediaFile.name || "arquivo";
  if (size) size.textContent = _formatFileSize(pendingMediaFile.size);

  if (thumb) {
    if (pendingMediaFile.type?.startsWith("image/")) {
      const url = URL.createObjectURL(pendingMediaFile);
      thumb.innerHTML = `<img src="${url}" alt="Prévia">`;
    } else if (pendingMediaFile.type?.startsWith("video/")) {
      thumb.innerHTML = `<i class="fa-solid fa-file-video"></i>`;
    } else {
      thumb.innerHTML = `<i class="fa-solid fa-file-lines"></i>`;
    }
  }
}

async function sendPendingMedia() {
  if (sendingConversationMessage) return;
  if (!pendingMediaFile || !selectedConversationUser) return;

  const input   = document.getElementById("conversation-message");
  const caption = input?.value?.trim() || "";
  const file    = pendingMediaFile;
  const quotedMessageId = replyingTo?.messageId || null;

  sendingConversationMessage = true;
  const sendBtn = document.getElementById("btn-send-conversation");
  const sendBtnIcon = sendBtn?.querySelector("i");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.setAttribute("aria-busy", "true"); }
  if (sendBtnIcon) sendBtnIcon.className = "fa-solid fa-circle-notch fa-spin";

  try {
    const form = new FormData();
    form.append("userId", selectedConversationUser);
    form.append("media", file);
    if (caption) form.append("caption", caption);
    if (quotedMessageId) form.append("quotedMessageId", quotedMessageId);

    const res = await apiFetch(`${BASE}/api/messages/send-media`, {
      method: "POST",
      body:   form,
      timeoutMs: 60000 // upload pode demorar mais que o timeout padrão de 20s
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Arquivo enviado!");
    if (input) input.value = "";
    resetTextareaHeight(input);
    cancelMediaSelection();
    if (quotedMessageId && replyingTo?.messageId === quotedMessageId) cancelReplyTo();
    if (selectedConversationUser) humanModeUsers.add(selectedConversationUser);

    if (!socket?.connected) {
      await loadHistory(false);
      await loadConversations();
      if (selectedConversationUser) openConversation(selectedConversationUser);
    }
  } catch (err) {
    showToast(`❌ Erro ao enviar arquivo: ${err.message}`);
  } finally {
    sendingConversationMessage = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.removeAttribute("aria-busy"); }
    if (sendBtnIcon) sendBtnIcon.className = "fa-solid fa-paper-plane";
  }
}

// ─── Feature: responder mensagem específica (reply/quote) ───────────────────
// Pedido do usuário (2026-07-23): "responder mensagens especificas também
// funcionando igual whatsapp". Escopo: só mensagens de TEXTO do cliente
// podem ser citadas — ver comentário em cima do bloco de render da bolha do
// cliente (mais acima nesta seção) e _buscarContextoCitacao em
// message.controller.js pro motivo técnico.
function replyToMessage(messageId, text) {
  if (!messageId) return;
  replyingTo = { messageId, text: text || "" };
  renderReplyPreviewBar();
  document.getElementById("conversation-message")?.focus();
}

function cancelReplyTo() {
  replyingTo = null;
  renderReplyPreviewBar();
}

function renderReplyPreviewBar() {
  const bar     = document.getElementById("reply-preview-bar");
  const snippet = document.getElementById("reply-preview-snippet");
  if (!bar) return;

  if (!replyingTo) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");
  if (snippet) snippet.textContent = (replyingTo.text || "").slice(0, 140);
}

// Delegação de clique nas bolhas do cliente (botão "Responder") — a lista de
// mensagens é toda recriada a cada openConversation(), então usa o mesmo
// padrão de delegação (bind uma vez, no container fixo) de
// bindConversationListDelegation/bindConversationHeaderDelegation acima.
function bindConversationMessagesDelegation() {
  const box = document.getElementById("chat-messages");
  if (!box || box.dataset.delegated === "true") return;
  box.dataset.delegated = "true";

  box.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-reply-msg-id]");
    if (!btn || !box.contains(btn)) return;
    replyToMessage(btn.dataset.replyMsgId, btn.dataset.replyText || "");
  });
}

// ─── Drag & drop + colar (Ctrl+V) na janela da conversa ──────────────────────
// Pedido do usuário: "Isso + colar/arrastar direto na conversa" (attach
// button JÁ cobre a escolha manual — isso cobre os outros dois jeitos).
function initConversationMediaEvents() {
  const dropzone = document.getElementById("chat-input-area");
  const textarea = document.getElementById("conversation-message");

  if (dropzone && dropzone.dataset.dndBound !== "true") {
    dropzone.dataset.dndBound = "true";
    ["dragover", "dragenter"].forEach(evt => {
      dropzone.addEventListener(evt, (e) => {
        if (!selectedConversationUser) return;
        e.preventDefault();
        dropzone.classList.add("drag-over");
      });
    });
    ["dragleave", "dragend"].forEach(evt => {
      dropzone.addEventListener(evt, () => dropzone.classList.remove("drag-over"));
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag-over");
      const file = e.dataTransfer?.files?.[0];
      if (file) setPendingMediaFile(file);
    });
  }

  if (textarea && textarea.dataset.pasteBound !== "true") {
    textarea.dataset.pasteBound = "true";
    textarea.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            setPendingMediaFile(file);
            break;
          }
        }
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", initConversationMediaEvents);

// ─── Chat rápido (modal legado) ───────────────────────────────────────────────
function abrirChat(userId) {
  currentChatUser = userId;
  document.getElementById("chat-user").textContent = `Cliente: ${formatPhone(userId)}`;
  document.getElementById("chat-message").value    = "";
  openWithMotion(document.getElementById("chat-modal"));
}

function fecharChat() {
  closeWithMotion(document.getElementById("chat-modal"));
}

let _sendingManual = false;
async function enviarMensagemManual() {
  if (_sendingManual) return;
  const textarea = document.getElementById("chat-message");
  const message  = textarea?.value?.trim();

  if (!message || !currentChatUser) {
    showToast("Digite uma mensagem antes de enviar.");
    return;
  }

  _sendingManual = true;
  try {
    await fetch(`${BASE}/api/messages/typing`, {
      credentials: "include",
      method:  "POST",
      headers: apiHeaders(),
      body:    JSON.stringify({ userId: currentChatUser })
    });

    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId: currentChatUser, message })
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");
    await loadHistory(false);
    await loadConversations();
    textarea.value = "";
    fecharChat();
  } catch (err) {
    showToast(`❌ Erro ao enviar: ${err.message}`);
  } finally {
    _sendingManual = false;
  }
}

// ─── Status de mensagem ───────────────────────────────────────────────────────
// renderMessageStatus extraído para js/conversations/conversations-utils.js

function notifyTyping() {
  if (!selectedConversationUser) return;
  const now = Date.now();
  if (now - lastTypingAt < 1200) return;
  lastTypingAt = now;
  fetch(`${BASE}/api/messages/typing`, {
    credentials: "include",
    method:  "POST",
    headers: apiHeaders(),
    body:    JSON.stringify({ userId: selectedConversationUser })
  }).catch(() => {});
}

// ─── Notificações (dropdown topbar) ──────────────────────────────────────────
const _notifItems = []; // { type, text, time, userId? }

function pushNotification(type, text, userId) {
  _notifItems.unshift({ type, text, time: new Date(), userId });
  if (_notifItems.length > 30) _notifItems.pop();
  renderNotifDropdown();
  // BUG CORRIGIDO: o pontinho vermelho do sino (".has-alert") só era ligado
  // em showNewTicketAlert (novo ticket) — notificação de NOVA MENSAGEM
  // (nova_mensagem no 12-socket.js) chamava pushNotification() mas nunca
  // acendia o dot, então a notificação entrava na lista silenciosamente e
  // não tinha nenhum sinal visual pro atendente saber que tinha algo novo
  // pra ver, a não ser abrindo o dropdown manualmente. Centralizado aqui
  // pra valer pra qualquer tipo de notificação futura.
  document.querySelector(".notification")?.classList.add("has-alert");
  showDesktopNotification(type, text, userId);
}

// ─── Notificação nativa do SO (Notification Web API) ────────────────────────
// Antes disso, "notificação" era só toast + dropdown interno — nada aparecia
// se a aba não estivesse aberta/em foco (motivo provável de "às vezes a
// notificação não aparece" com o painel minimizado ou noutra janela).
// A permissão é pedida uma única vez logo após login bem-sucedido (ver
// window.requestNotificationPermission?.() em 02-auth.js) — nunca insiste
// se o usuário já negou (Notification.permission === "denied").
function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {
    }).finally(() => atualizarStatusNotificacaoNavegador());
  }
}

// Pedido do usuário (2026-07-30): status + botão em Configurações pra
// (re)ativar a notificação do navegador — a permissão só era pedida 1x
// automaticamente logo após login; se o atendente fechasse/negasse o popup
// sem querer, não tinha como tentar de novo sem mexer manualmente nas
// configurações do site no Chrome. Chamado ao abrir a aba Configurações
// (switchTab, 03-navigation.js) e depois de qualquer tentativa de pedir
// permissão, pra refletir o estado real.
function atualizarStatusNotificacaoNavegador() {
  const status = document.getElementById("browser-notif-status");
  const btn = document.getElementById("btn-ativar-notif-navegador");
  if (!status || !btn) return;

  if (!("Notification" in window)) {
    status.textContent = "Não suportado neste navegador.";
    btn.classList.add("hidden");
    return;
  }

  if (Notification.permission === "granted") {
    status.textContent = "Ativadas — você recebe aviso do sistema com o painel em segundo plano.";
    btn.classList.add("hidden");
  } else if (Notification.permission === "denied") {
    status.textContent = "Bloqueadas pelo navegador. Precisa liberar manualmente nas permissões do site (ícone de cadeado na barra de endereço).";
    btn.classList.add("hidden");
  } else {
    status.textContent = "Ainda não ativadas.";
    btn.classList.remove("hidden");
  }
}

// Só funciona chamado a partir de um clique de verdade (gesto do usuário) —
// por isso é uma função separada, ligada ao botão "Ativar" acima, e não
// disparada sozinha.
function ativarNotificacaoNavegador() {
  if (!("Notification" in window)) return;
  Notification.requestPermission()
    .catch(() => {})
    .finally(() => atualizarStatusNotificacaoNavegador());
}

function showDesktopNotification(type, text, userId) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  // Só dispara a notificação nativa se o atendente NÃO está olhando a aba —
  // com a aba visível e em foco, o toast + dropdown já bastam; duplicar
  // com um popup do SO em cima seria só redundante/irritante.
  if (document.visibilityState === "visible" && document.hasFocus()) return;

  try {
    const title = type === "ticket" ? "🎫 Novo atendimento" : "💬 Nova mensagem";
    const n = new Notification(title, {
      body: text,
      tag:  userId ? `rildon-${userId}` : undefined, // agrupa por cliente, evita empilhar várias do mesmo
      icon: "android-chrome-512x512.png"
    });
    n.onclick = () => {
      window.focus();
      n.close();
      if (userId) {
        closeNotifDropdown();
        switchTab("conversations");
        setTimeout(() => openConversation(userId), 200);
      }
    };
  } catch (_) {}
}

function renderNotifDropdown() {
  const list = document.getElementById("notif-list");
  if (!list) return;
  if (!_notifItems.length) {
    list.innerHTML = `<li class="notif-empty">Nenhuma notificação</li>`;
    return;
  }
  list.innerHTML = _notifItems.map((n, i) => {
    const iconClass = n.type === "ticket" ? "ticket" : "message";
    const icon = n.type === "ticket" ? "fa-ticket" : "fa-message";
    const ago = _notifTimeAgo(n.time);
    const userAttr = n.userId ? `data-notif-user="${escapeAttr(n.userId)}"` : "";
    return `<li ${userAttr} ${n.userId ? 'tabindex="0" role="button"' : ''}>
      <span class="notif-icon ${iconClass}"><i class="fa-solid ${icon}"></i></span>
      <div class="notif-body">
        <strong>${safe(n.text)}</strong>
        <span>${ago}</span>
      </div>
    </li>`;
  }).join("");
}

// _notifTimeAgo extraído para js/conversations/conversations-utils.js

function toggleNotifDropdown() {
  const btn      = document.getElementById("btn-notifications");
  const dropdown = document.getElementById("notif-dropdown");
  if (!dropdown) return;
  const isOpen = !dropdown.classList.contains("hidden");
  if (isOpen) {
    closeNotifDropdown();
  } else {
    openWithMotion(dropdown);
    btn?.setAttribute("aria-expanded", "true");
    // Limpa o dot ao abrir
    document.querySelector(".notification")?.classList.remove("has-alert");
  }
}

function closeNotifDropdown() {
  closeWithMotion(document.getElementById("notif-dropdown"));
  document.getElementById("btn-notifications")?.setAttribute("aria-expanded", "false");
}

function clearNotifications() {
  _notifItems.length = 0;
  renderNotifDropdown();
}

// Fecha o dropdown ao clicar fora dele
document.addEventListener("click", (e) => {
  const wrap = e.target.closest(".notif-wrap");
  if (!wrap) closeNotifDropdown();
});

function updateSidebarUnreadBadge() {
  const badge = document.getElementById("sidebar-unread-count");
  if (!badge) return;
  const totalUnread = Object.values(unreadMessages).reduce((sum, v) => sum + Number(v || 0), 0);
  if (totalUnread > 0) {
    badge.textContent = totalUnread > 99 ? "99+" : totalUnread;
    badge.classList.remove("hidden");
  } else {
    badge.textContent = "0";
    badge.classList.add("hidden");
  }
}


function initNotificationDelegation() {
  const list = document.getElementById("notif-list");
  if (!list || list.dataset.delegated === "1") return;
  list.dataset.delegated = "1";
  const openNotifUser = (item) => {
    const userId = item?.dataset?.notifUser;
    if (!userId) return;
    closeNotifDropdown();
    switchTab("conversations");
    setTimeout(() => openConversation(userId), 200);
  };
  list.addEventListener("click", (event) => openNotifUser(event.target.closest("[data-notif-user]")));
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const item = event.target.closest("[data-notif-user]");
    if (!item) return;
    event.preventDefault();
    openNotifUser(item);
  });
}

document.addEventListener("DOMContentLoaded", initNotificationDelegation);
