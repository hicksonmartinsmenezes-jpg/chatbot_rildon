// 12-socket.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Painel WhatsApp / QR Code ────────────────────────────────────────────────
let _waQrTimer = null;

function renderWaQr(qr) {
  const canvas   = document.getElementById("wa-qr-canvas");
  const area     = document.getElementById("wa-qr-area");
  const waiting  = document.getElementById("wa-waiting-area");
  const connArea = document.getElementById("wa-connected-area");
  if (!canvas) return;

  if (typeof QRCode === "undefined") return;

  QRCode.toCanvas(canvas, qr, { width: 220, margin: 2 }, (err) => {
    if (err) return;
    area?.classList.remove("hidden");
    waiting?.classList.add("hidden");
    connArea?.classList.add("hidden");
  });

  // Contagem regressiva de 60s (QR expira)
  clearInterval(_waQrTimer);
  let secs = 60;
  const secEl = document.getElementById("wa-qr-seconds");
  if (secEl) secEl.textContent = secs;
  _waQrTimer = setInterval(() => {
    secs--;
    if (secEl) secEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(_waQrTimer);
      area?.classList.add("hidden");
      waiting?.classList.remove("hidden");
    }
  }, 1000);
}

function updateWaStatusPanel(status) {
  const statusText = document.getElementById("wa-status-text");
  const homeBadge  = document.getElementById("wa-home-badge");
  const topBadge   = document.getElementById("status-badge");
  const area       = document.getElementById("wa-qr-area");
  const connArea   = document.getElementById("wa-connected-area");
  const waiting    = document.getElementById("wa-waiting-area");

  if (status === "connected") {
    if (statusText) { statusText.textContent = "● Conectado"; statusText.className = "badge badge-on"; }
    if (homeBadge)  { homeBadge.textContent  = "●"; homeBadge.className = "badge badge-on"; }
    if (topBadge)   { topBadge.textContent   = "● Online"; topBadge.className = "badge badge-on"; }
    area?.classList.add("hidden");
    connArea?.classList.remove("hidden");
    waiting?.classList.add("hidden");
    clearInterval(_waQrTimer);
  } else {
    if (statusText) { statusText.textContent = "● Desconectado"; statusText.className = "badge badge-off"; }
    if (homeBadge)  { homeBadge.textContent  = "●"; homeBadge.className = "badge badge-off"; }
    if (topBadge)   { topBadge.textContent   = "● Offline"; topBadge.className = "badge badge-off"; }
    if (status !== "qr") {
      area?.classList.add("hidden");
      connArea?.classList.add("hidden");
      waiting?.classList.remove("hidden");
    }
  }
}

// Busca o estado atual da conexão e renderiza o QR pendente, se houver.
// O evento socket "qr_code" é efêmero — se o painel for aberto depois dele,
// esta função recupera o QR que ficou guardado no backend.
async function loadWaStatus() {
  try {
    const res = await apiFetch(`${BASE}/api/whatsapp/status`);
    if (!res?.ok) return;
    const info = await res.json();
    if (info.connected) {
      updateWaStatusPanel("connected");
    } else if (info.qr) {
      updateWaStatusPanel("qr");
      renderWaQr(info.qr);
    } else {
      updateWaStatusPanel("disconnected");
    }
  } catch (_) {}
}

async function requestWaReconnect() {
  // Se já está conectado, gerar um QR novo exige DESCONECTAR a sessão atual.
  const statusText  = document.getElementById("wa-status-text")?.textContent || "";
  const isConnected = /conectado/i.test(statusText) && !/desconect/i.test(statusText);

  const doReconnect = async (clearSession = false) => {
    try {
      const res = await apiFetch(`${BASE}/api/whatsapp/reconnect`, {
        method: "POST",
        body: JSON.stringify({ clearSession })
      });
      if (res?.ok) {
        showToast("🔄 Reconexão solicitada. Aguarde o QR Code...");
        const area    = document.getElementById("wa-qr-area");
        const waiting = document.getElementById("wa-waiting-area");
        const conn    = document.getElementById("wa-connected-area");
        area?.classList.add("hidden");
        conn?.classList.add("hidden");
        waiting?.classList.remove("hidden");
        // Fallback: se o evento socket "qr_code" não chegar, busca o QR pendente.
        setTimeout(loadWaStatus, 2500);
        return;
      }

      const data = await res?.json().catch(() => ({}));
      showToast(`❌ ${data.error || "Não foi possível reconectar."}`);
    } catch (err) {
      showToast(`❌ Erro ao reconectar WhatsApp: ${err.message}`);
    }
  };

  if (isConnected) {
    const message = "O WhatsApp está conectado. Gerar um novo QR Code vai desconectar a sessão atual e você precisará escanear novamente no celular. Deseja continuar?";
    if (typeof showConfirmModal === "function") {
      showConfirmModal({
        title: "Reconectar WhatsApp",
        message,
        confirmText: "Reconectar",
        cancelText: "Cancelar",
        danger: true,
        onConfirm: () => doReconnect(true)
      });
      return;
    }

    // Fallback raro, caso o arquivo de modal não tenha carregado.
    if (!confirm(message)) return;
    return doReconnect(true);
  }

  return doReconnect(false);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
let socket = null;

if (typeof io !== "undefined") {

  // BUG CORRIGIDO: autoConnect:true fazia o socket tentar conectar assim que
  // a página carregava, ANTES do login — sem sessão ainda, o servidor
  // rejeitava com "Não autenticado." e o handler de connect_error abaixo
  // mostrava "Sessão expirada. Faça login novamente." repetidamente a cada
  // tentativa de reconexão (a cada poucos segundos), mesmo o usuário nunca
  // tendo efetivamente logado — parecia um loop de "logando e expirando".
  // Agora o socket só conecta depois de confirmar sessão válida: chamado
  // explicitamente em login()/submitTwoFactorLogin() (02-auth.js) após
  // sucesso, e em checkAuth() quando já existe sessão válida ao carregar a
  // página. connectPanelSocket()/disconnectPanelSocket() ficam expostos
  // globalmente pra isso.
  socket = io(BASE, {
    autoConnect: false,
    withCredentials: true,
    reconnectionDelay: 2000,        // espera 2s antes da 1ª tentativa
    reconnectionDelayMax: 15000,    // máximo 15s entre tentativas (backoff exponencial)
    reconnectionAttempts: 10,       // desiste após 10 falhas consecutivas
    timeout: 10000                  // 10s para estabelecer conexão inicial
  });

  window.connectPanelSocket = () => {
    if (!socket.connected) socket.connect();
  };
  window.disconnectPanelSocket = () => {
    socket.disconnect();
  };

  // Trata falha de autenticação no socket (sessão expirada DE VERDADE — só
  // conecta depois de login, então um connect_error aqui significa que a
  // sessão que já estava ativa expirou/foi invalidada, não que nunca existiu)
  socket.on("connect_error", (err) => {
    if (err.message === "Não autenticado." || err.message === "Sessão inválida ou expirada.") {
      socket.disconnect();
      showToast("⚠️ Sessão expirada. Faça login novamente.");
    }
  });

  socket.on("connect", () => {
    setOnline();
    const user = getCurrentUser();
    if (user) socket.emit("user_online", user);
  });

  socket.on("disconnect", () => {
    setOffline();
    // Cancela reloads pendentes para evitar requisições órfãs após desconexão
    clearTimeout(_convReloadTimer);
    clearTimeout(_histReloadTimer);
    clearTimeout(_ticketReloadTimer);
    clearTimeout(_contactsReloadTimer);
    clearTimeout(_broadcastsReloadTimer);
    _convReloadTimer = _histReloadTimer = _ticketReloadTimer = _contactsReloadTimer = _broadcastsReloadTimer = null;
  });

  socket.on("online_users", users => {
    window.onlineUsers = Array.isArray(users) ? users : [];
    if (currentTab === "settings") renderPanelUsers();
  });

  socket.on("users_updated", data => {
    document.dispatchEvent(new CustomEvent("rildon:users-updated", { detail: data || {} }));
  });

  // Atualizações administrativas em tempo real
  let _contactsReloadTimer = null;
  let _broadcastsReloadTimer = null;

  socket.on("contacts_updated", (data) => {
    document.dispatchEvent(new CustomEvent("rildon:contacts-updated", { detail: data || {} }));
    if (currentTab !== "contacts" && currentTab !== "channels") return;

    clearTimeout(_contactsReloadTimer);
    _contactsReloadTimer = setTimeout(() => {
      if (currentTab === "contacts") {
        if (typeof loadContacts === "function") loadContacts(true);
        if (typeof loadContactsTags === "function") loadContactsTags();
      }
      if (currentTab === "channels" && typeof updateCampaignAudienceCount === "function") {
        updateCampaignAudienceCount();
      }
    }, 350);
  });

  socket.on("broadcasts_updated", (data) => {
    document.dispatchEvent(new CustomEvent("rildon:broadcasts-updated", { detail: data || {} }));
    if (currentTab !== "channels") return;

    clearTimeout(_broadcastsReloadTimer);
    _broadcastsReloadTimer = setTimeout(() => {
      if (typeof loadCampaigns === "function") loadCampaigns();
      if (typeof loadCampaignStats === "function") loadCampaignStats();
    }, 350);
  });

  // Debounce timers para evitar múltiplos reloads simultâneos por rajada de eventos
  let _convReloadTimer   = null;
  let _histReloadTimer   = null;
  let _ticketReloadTimer = null;

function _scheduleConvReload(userId) {
  clearTimeout(_convReloadTimer);
  _convReloadTimer = setTimeout(() => {
    loadConversations(true).then(() => {
      if (!userId) return;
      const ticket = ticketsByUser[userId];
      // BUG CORRIGIDO: aqui assumíamos "fechado = pendentes" sem checar se o
      // ticket fechado de fato voltou a ter atividade (ver estaPendente() em
      // 07-conversations.js, window.estaPendente, definida por
      // loadConversations logo acima) — agora usa a mesma regra da lista,
      // pra trocar de aba só quando o cliente realmente vai aparecer lá.
      const pendente = typeof window.estaPendente === "function"
        ? window.estaPendente(userId)
        : (!ticket || ticket.status === "aberto");
      const correctFilter = pendente
        ? "pendentes"
        : ticket?.status === "em_andamento" ? "em_andamento" : null;
      if (correctFilter && activeTicketFilter !== correctFilter) {
        const btn = document.querySelector(`.chat-status-tab[data-filter="${correctFilter}"]`);
        if (btn) setTicketFilter(correctFilter, btn);
      }
    });
  }, 400);
}

socket.on("nova_mensagem", (data) => {
  // Valida estrutura mínima
  if (!data?.userId || typeof data.userId !== "string") return;

  // O backend emite esse evento DUAS vezes para a mesma mensagem do cliente:
  // 1) ao chegar (response: null) e 2) depois do bot/IA processar (response
  // preenchido) — mesmo messageId nos dois. Antes, quando o messageId batia,
  // o código só IGNORAVA o segundo evento em vez de mesclar a resposta no
  // item já existente — isso deixava o item "congelado" com response: null
  // em allHistory (a resposta do bot nunca era refletida ali), e quando o
  // messageId não vinha preenchido (versão antiga do backend, sem restart),
  // o fallback por tempo (3s) falhava com processamento mais lento, criando
  // um SEGUNDO item de verdade → 1 mensagem real virava 2 na tela.
  const existingIndex = data.messageId
    ? allHistory.findIndex(item => item.messageId === data.messageId)
    : allHistory.findIndex(item =>
        item.userId === data.userId &&
        item.message === data.message &&
        Math.abs(new Date(item.createdAt) - new Date(data.createdAt)) < 3000
      );

  if (existingIndex === -1) {
    allHistory.unshift(data);
  } else {
    // Mescla em vez de duplicar ou descartar: mantém o item existente e só
    // atualiza os campos que o novo evento trouxe de novo (tipicamente a
    // resposta do bot, chegando depois do processamento).
    allHistory[existingIndex] = { ...allHistory[existingIndex], ...data };
  }

  // isCurrentConversation também precisa checar a aba atual — sem isso,
  // selectedConversationUser continua apontando pra última conversa aberta
  // mesmo depois do atendente sair da aba "Conversas", fazendo notificação
  // e contador de não lidas sumirem para esse cliente mesmo com o painel
  // fechado ou noutra aba (reportado pelo usuário).
  const isCurrentConversation = currentTab === "conversations" && selectedConversationUser === data.userId;

  // BUG CORRIGIDO: faltava o mesmo filtro "!data.response" usado logo abaixo
  // (som/toast/pushNotification). Sem ele, o contador de não lidas somava
  // DUAS vezes pra mensagem do cliente que recebe resposta do bot (1º evento
  // com response:null, 2º evento com response preenchido — ambos incrementavam)
  // e também subia o contador quando OUTRO atendente respondia manualmente
  // essa conversa (message.controller.js emite nova_mensagem com response
  // preenchido pro próprio envio do atendente, e esse emit vai pra TODOS os
  // painéis conectados) — fazendo a conversa parecer "não lida" mesmo quando
  // a última coisa que aconteceu foi um atendente responder, não o cliente.
  if (!isCurrentConversation && !data.response) {
    unreadMessages[data.userId] = (unreadMessages[data.userId] || 0) + 1;
    updateSidebarUnreadBadge();
    persistUnreadMessages();
  }

  if (currentTab === "conversations") {
    if (isCurrentConversation) {
      openConversation(data.userId, false);
    } else {
      _scheduleConvReload(data.userId);
    }
  }

  if (currentTab === "history") {
    clearTimeout(_histReloadTimer);
    _histReloadTimer = setTimeout(() => loadHistory(true), 400);
  }

  if (currentTab === "dashboard" || currentTab === "tickets") {
    clearTimeout(_ticketReloadTimer);
    _ticketReloadTimer = setTimeout(() => loadTickets(), 400);
  }

  if (currentTab === "metrics") {
    loadMetricsCharts();
  }

  if (!data.response && !isCurrentConversation) {
    playAlertSound("message");
    showToast("💬 Nova mensagem recebida!");
    if (typeof pushNotification === "function") {
      const nome = data.contactName || formatPhone(data.userId);
      // PEDIDO DO USUÁRIO (2026-08-14): notificação do SO não deve mostrar o
      // rótulo interno "[imagem recebida]"/"[sticker recebido]" como se
      // fosse o texto do cliente — troca por um rótulo amigável (ver
      // mediaPlaceholderFriendlyLabel em conversations-utils.js).
      const textoMsg = mediaPlaceholderFriendlyLabel(data.message) || data.message || "";
      pushNotification("message", `${nome}: ${textoMsg.slice(0, 60)}`, data.userId);
    }
  }
});
socket.on("typing", data => {
  if (data.from !== "client") return;
  if (selectedConversationUser !== data.userId) return;

  const status = document.getElementById("chat-typing-status");
  if (!status) return;

  status.textContent = "Digitando...";

  clearTimeout(window.typingTimeout);

  window.typingTimeout = setTimeout(() => {
    status.textContent = "";
  }, 2000);
});

  socket.on("message_status", (data) => {
    allHistory = allHistory.map(item =>
      item.messageId === data.messageId ? { ...item, status: data.status } : item
    );

    // Atualiza só o ícone de status no DOM — sem re-render completo nem chamada API
    if (data.messageId && currentTab === "conversations") {
      document.querySelectorAll(`.bubble[data-msg-id="${data.messageId}"] .msg-status`).forEach(el => {
        el.innerHTML = renderMessageStatus(data.status);
      });
    }
  });

  // BUG CORRIGIDO: assumir/transferir/fechar/reabrir um ticket só refletia na
  // própria aba que fez a ação (via reload local logo após o fetch) — outras
  // sessões conectadas (outro atendente, ou um painel admin observando a
  // mesma conversa) ficavam com o status antigo até o poll de 30s. Backend
  // agora emite "ticket_atualizado" em toda mudança (assumirTicket,
  // transferirTicket, patchTicket) — atualiza o estado local e re-renderiza
  // a conversa aberta e/ou a lista de tickets, o que for relevante pra aba atual.
  socket.on("ticket_atualizado", ({ ticket } = {}) => {
    if (!ticket?.userId) return;

    if (typeof ticketsByUser === "object" && ticketsByUser) {
      ticketsByUser[ticket.userId] = ticket;
    }

    // BUG CORRIGIDO: contador de não-lidas ficava preso num ticket já
    // FECHADO (resolvido/cancelado) — reportado pelo usuário como "badge de
    // mensagens novas aparece em Fechados" mesmo sem nada pendente/ativo.
    // unreadMessages só era zerado ao abrir a conversa (openConversation);
    // se o ticket foi fechado sem que ninguém tenha aberto a conversa por
    // último (ex: fechado em lote, ou o próprio contador nunca foi visto),
    // o número ficava ali indefinidamente na aba Fechados. Roda em toda
    // sessão conectada (não só quem clicou Fechar), já que o evento é
    // broadcast.
    if (
      (ticket.status === "resolvido" || ticket.status === "cancelado") &&
      unreadMessages[ticket.userId]
    ) {
      unreadMessages[ticket.userId] = 0;
      if (typeof updateSidebarUnreadBadge === "function") updateSidebarUnreadBadge();
      if (typeof persistUnreadMessages === "function") persistUnreadMessages();
    }

    if (currentTab === "conversations") {
      if (selectedConversationUser === ticket.userId && typeof openConversation === "function") {
        openConversation(ticket.userId, false);
      }
      if (typeof _scheduleConvReload === "function") _scheduleConvReload(ticket.userId);
    }

    if ((currentTab === "dashboard" || currentTab === "tickets") && typeof loadTickets === "function") {
      clearTimeout(_ticketReloadTimer);
      _ticketReloadTimer = setTimeout(() => loadTickets(), 400);
    }

    if (currentTab === "metrics" && typeof loadMetricsCharts === "function") loadMetricsCharts();
  });

  // Ver nota acima — mesmo problema, mas para "assumir" (pausa o bot) e
  // "Devolver ao bot" (reativa), que passam por humanMode.service.js em vez
  // de uma mudança de status de ticket.
  socket.on("humanmode_atualizado", ({ userId, active } = {}) => {
    if (!userId || typeof humanModeUsers === "undefined" || !humanModeUsers) return;

    if (active) humanModeUsers.add(userId);
    else humanModeUsers.delete(userId);

    if (currentTab === "conversations") {
      if (selectedConversationUser === userId && typeof openConversation === "function") {
        openConversation(userId, false);
      }
      if (typeof _scheduleConvReload === "function") _scheduleConvReload(userId);
    }
  });

  // QR Code do WhatsApp emitido pelo backend
  socket.on("qr_code", ({ qr }) => {
    const badge = document.getElementById("status-badge");
    if (badge) { badge.textContent = "⏳ Aguardando QR"; badge.className = "badge badge-off"; }
    showToast("📱 QR Code disponível em Configurações → WhatsApp.");
    renderWaQr(qr);
  });

  socket.on("whatsapp_status", ({ status }) => {
    if (status === "connected") setOnline(); else setOffline();
    updateWaStatusPanel(status);
  });

  // Alguém ligou/desligou o bot (qualquer atendente, ver botStatus.routes.js)
  // — atualiza o toggle da topbar em TODOS os painéis conectados na hora,
  // não só em quem clicou.
  socket.on("bot_status_atualizado", ({ ativo, por } = {}) => {
    if (typeof renderBotToggleStatus === "function") renderBotToggleStatus(ativo !== false);
    if (typeof getCurrentUser === "function") {
      const eu = getCurrentUser();
      if (por && eu?.nome !== por) {
        showToast(ativo ? `🤖 ${por} ativou o bot.` : `🤖 ${por} desativou o bot.`);
      }
    }
    // Se a Central de Configurações (admin) estiver aberta com o form
    // carregado, mantém o select "Bot ativo" sincronizado também.
    if (typeof currentSettings === "object" && currentSettings?.bot) {
      currentSettings.bot.ativo = ativo !== false;
      if (typeof setValue === "function") setValue("bot-active", String(ativo !== false));
    }
  });
}
