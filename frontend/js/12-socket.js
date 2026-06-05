// 12-socket.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Socket.IO ────────────────────────────────────────────────────────────────
let socket = null;

if (typeof io !== "undefined") {
  
  socket = io(BASE, { autoConnect: true });

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
});

socket.on("online_users", users => {

  window.onlineUsers = users;

  renderPanelUsers();
});

  socket.on("whatsapp_status", ({ status }) => {
    if (status === "connected") setOnline(); else setOffline();
  });

 socket.on("nova_mensagem", (data) => {
  const alreadyExists =
    data.messageId &&
    allHistory.some(item => item.messageId === data.messageId);

  if (!alreadyExists) {
    allHistory.unshift(data);
  }

  const isCurrentConversation =
    selectedConversationUser === data.userId;

  if (data?.userId && !isCurrentConversation) {
    unreadMessages[data.userId] =
      (unreadMessages[data.userId] || 0) + 1;
      updateSidebarUnreadBadge();
  }

  if (currentTab === "conversations") {
    if (isCurrentConversation) {
      openConversation(data.userId, false);
    } else {
      loadConversations();
    }
  }

  if (currentTab === "history") {
    loadHistory(true);
  }

  if (currentTab === "dashboard" || currentTab === "tickets") {
    loadTickets();
  }

  if (currentTab === "metrics") {
    loadMetricsCharts();
  }

  playAlertSound("message");

  if ((!data.response || data.message) && !isCurrentConversation) {
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
