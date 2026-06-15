// 12-socket.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Socket.IO ────────────────────────────────────────────────────────────────
let socket = null;

if (typeof io !== "undefined") {

  socket = io(BASE, { autoConnect: true, withCredentials: true });

  // Trata falha de autenticação no socket (sessão expirada)
  socket.on("connect_error", (err) => {
    if (err.message === "Não autenticado." || err.message === "Sessão inválida ou expirada.") {
      socket.disconnect();
      showToast("⚠️ Sessão expirada. Faça login novamente.");
    }
  });

socket.on("connect", () => {

  setOnline();

  const user = getCurrentUser();

  if (user) {

    socket.emit(
      "user_online",
      user
    );
  }
});

  socket.on("disconnect", () => {
    setOffline();
    // Cancela reloads pendentes para evitar requisições órfãs após desconexão
    clearTimeout(_convReloadTimer);
    clearTimeout(_histReloadTimer);
    clearTimeout(_ticketReloadTimer);
    _convReloadTimer = _histReloadTimer = _ticketReloadTimer = null;
  });

socket.on("online_users", users => {
  window.onlineUsers = Array.isArray(users) ? users : [];
  renderPanelUsers();

  // Atualiza status online/offline na conversa aberta em tempo real
  if (selectedConversationUser) {
    const statusEl = document.querySelector(".chat-contact-status");
    if (statusEl) {
      const isOnline = window.onlineUsers.some(u => u.userId === selectedConversationUser);
      statusEl.textContent = isOnline ? "Online" : "Offline";
      statusEl.className = `chat-contact-status ${isOnline ? "online" : "offline"}`;
    }
  }
});

  socket.on("whatsapp_status", ({ status }) => {
    if (status === "connected") setOnline(); else setOffline();
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
      const isClosed = ticket?.status === "resolvido" || ticket?.status === "cancelado";
      const correctFilter = (!ticket || ticket.status === "aberto" || isClosed)
        ? "pendentes"
        : ticket.status === "em_andamento" ? "em_andamento" : null;
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

  // Deduplicação: por messageId se disponível, senão por userId+message+timestamp próximo
  const alreadyExists = data.messageId
    ? allHistory.some(item => item.messageId === data.messageId)
    : allHistory.some(item =>
        item.userId === data.userId &&
        item.message === data.message &&
        Math.abs(new Date(item.createdAt) - new Date(data.createdAt)) < 3000
      );

  if (!alreadyExists && data.response) allHistory.unshift(data);

  const isCurrentConversation = selectedConversationUser === data.userId;

  if (!isCurrentConversation) {
    unreadMessages[data.userId] = (unreadMessages[data.userId] || 0) + 1;
    updateSidebarUnreadBadge();
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

    if (currentTab === "conversations" && selectedConversationUser) {
      openConversation(selectedConversationUser, false);
    }
  });

  // QR Code do WhatsApp emitido pelo backend
  socket.on("qr_code", ({ qr }) => {
    const badge = document.getElementById("status-badge");
    if (badge) { badge.textContent = "⏳ Aguardando QR"; badge.className = "badge badge-off"; }
    showToast("📱 Escaneie o QR Code no terminal para conectar o WhatsApp.");
  });
}
