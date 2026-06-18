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

async function requestWaReconnect() {
  try {
    const res = await apiFetch(`${BASE}/api/whatsapp/reconnect`, { method: "POST" });
    if (res?.ok) {
      showToast("🔄 Reconexão solicitada. Aguarde o QR Code...");
      const area    = document.getElementById("wa-qr-area");
      const waiting = document.getElementById("wa-waiting-area");
      const conn    = document.getElementById("wa-connected-area");
      area?.classList.add("hidden");
      conn?.classList.add("hidden");
      waiting?.classList.remove("hidden");
    } else {
      showToast("❌ Falha ao solicitar reconexão.");
    }
  } catch { showToast("❌ Erro ao conectar."); }
}

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

  if (!alreadyExists) allHistory.unshift(data);

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
    if (typeof pushNotification === "function") {
      const nome = data.contactName || formatPhone(data.userId);
      pushNotification("message", `${nome}: ${(data.message || "").slice(0, 60)}`, data.userId);
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
}
