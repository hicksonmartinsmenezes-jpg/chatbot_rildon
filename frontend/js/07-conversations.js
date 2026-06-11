// 07-conversations.js

// ─── Estado local ─────────────────────────────────────────────────────────────
let activeTicketFilter = "pendentes";
let ticketsByUser      = {}; // userId → ticket mais recente
let _searchDebounceTimer = null;

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
  const list   = document.getElementById("chat-list");
  const total  = document.getElementById("chat-total");
  const search = document.getElementById("search-conversations")?.value?.trim().toLowerCase() || "";

  if (!silent && list) list.innerHTML = `<p class="loading chat-loading">Carregando...</p>`;

  try {
    const [histRes, ticketRes] = await Promise.all([
      apiFetch(`${BASE}/api/history?limit=200`),
      apiFetch(`${BASE}/api/tickets?limit=500`)
    ]);

    if (!histRes) return;

    const raw = await histRes.json();
    allHistory = Array.isArray(raw) ? raw : raw.data || [];

    // Monta mapa userId → ticket mais recente
    ticketsByUser = {};
    if (ticketRes?.ok) {
      const ticketData = await ticketRes.json();
      const tickets = ticketData.tickets || [];
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

    // Atualiza badges de contagem — oculta quando zero
    const pendentes   = Object.values(ticketsByUser).filter(t => t.status === "aberto").length;
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
      if (item?.userId && !usersSeen.has(item.userId)) {
        usersSeen.add(item.userId);
        users.push(item.userId);
      }
    }

    // Filtra por status de ticket conforme aba ativa
    if (activeTicketFilter === "pendentes") {
      // Sem ticket = cliente novo ainda no menu do bot → também aparece em Pendentes
      users = users.filter(uid => !ticketsByUser[uid] || ticketsByUser[uid]?.status === "aberto");
    } else if (activeTicketFilter === "em_andamento") {
      users = users.filter(uid => ticketsByUser[uid]?.status === "em_andamento");
    } else if (activeTicketFilter === "fechados") {
      users = users.filter(uid => {
        const s = ticketsByUser[uid]?.status;
        return s === "resolvido" || s === "cancelado";
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
      const statusBadge = ticket
        ? `<span class="conv-ticket-badge status-${ticket.status}">${statusLabel(ticket.status)}</span>`
        : "";

      return `
        <button class="chat-item" data-user="${escapeAttr(userId)}" onclick="openConversation('${escapeAttr(userId)}')">
          ${avatarHtml(userId, name)}
          <span class="chat-item-body">
            <span class="chat-item-top">
              <strong>${safe(name)}</strong>
              <small>${safe(time)}</small>
            </span>
            <span class="chat-item-bottom">
              <span>${safe(preview)}</span>
              ${unread > 0 ? `<span class="chat-unread">${unread}</span>` : ""}
            </span>
            ${statusBadge}
          </span>
        </button>
      `;
    }).join("");

    if (selectedConversationUser && users.includes(selectedConversationUser)) {
      openConversation(selectedConversationUser, true);
    }

  } catch (err) {
    console.error("Erro ao carregar conversas:", err);
    if (list) list.innerHTML = `<p class="empty chat-empty">❌ Erro ao carregar conversas.</p>`;
  }
}

function getLastHistoryItem(userId) {
  return allHistory
    .filter(item => item.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function lastMessage(userId) {
  const last   = getLastHistoryItem(userId);
  const text   = last?.message || last?.response || "Sem mensagens";
  const prefix = last?.response && !last?.message ? "Você: " : "";
  return cutText(`${prefix}${text}`, 52);
}

// ─── Abre conversa com header de ações de ticket ──────────────────────────────
function openConversation(userId, updateActive = true) {
  selectedConversationUser = userId;
  const hadUnread = unreadMessages[userId] > 0;
  unreadMessages[userId] = 0;
  updateSidebarUnreadBadge();

  if (hadUnread && updateActive) {
    setTimeout(() => loadConversations(), 100);
  }

  const header      = document.getElementById("chat-window-header");
  const messagesBox = document.getElementById("chat-messages");

  if (header) {
    const name     = getContactName(userId) || formatPhone(userId);
    const isOnline = window.onlineUsers?.some(u => u.userId === userId);
    const ticket   = ticketsByUser[userId];

    let actionButtons = "";
    if (ticket && ticket.status === "aberto") {
      actionButtons = `
        <button class="conv-action-btn conv-btn-aceitar" onclick="aceitarTicketConv('${ticket.id}')">
          <i class="fa-solid fa-check"></i> Aceitar
        </button>
        <button class="conv-action-btn conv-btn-transferir" onclick="transferirTicketConv('${ticket.id}')">
          <i class="fa-solid fa-right-left"></i> Transferir
        </button>
        <button class="conv-action-btn conv-btn-fechar" onclick="fecharTicketConv('${ticket.id}')">
          <i class="fa-solid fa-xmark"></i> Fechar
        </button>
      `;
    } else if (ticket && ticket.status === "em_andamento") {
      actionButtons = `
        <button class="conv-action-btn conv-btn-transferir" onclick="transferirTicketConv('${ticket.id}')">
          <i class="fa-solid fa-right-left"></i> Transferir
        </button>
        <button class="conv-action-btn conv-btn-fechar" onclick="fecharTicketConv('${ticket.id}')">
          <i class="fa-solid fa-xmark"></i> Fechar
        </button>
      `;
    } else if (!ticket || ticket.status === "resolvido" || ticket.status === "cancelado") {
      actionButtons = `
        <button class="conv-action-btn conv-btn-aceitar" onclick="reabrirTicketConv('${userId}')">
          <i class="fa-solid fa-rotate-left"></i> Reabrir
        </button>
      `;
    }

    header.innerHTML = `
      <div class="chat-header-profile">
        ${avatarHtml(userId, name, true)}
        <div class="chat-header-info">
          <strong class="chat-contact-name">${safe(name)}</strong>
          <span class="chat-contact-status ${isOnline ? "online" : "offline"}">${isOnline ? "Online" : "Offline"}</span>
          ${ticket ? `<span class="chat-ticket-ref">#${safe(ticket.protocolo || ticket.id)} · ${safe(ticket.sector || "geral")}</span>` : ""}
          <div id="chat-typing-status"></div>
        </div>
      </div>
      <div class="chat-header-actions">
        ${actionButtons}
      </div>
    `;
  }

  if (updateActive) {
    document.querySelectorAll(".chat-item").forEach(item => item.classList.remove("active"));
    document.querySelector(`.chat-item[data-user="${cssEscape(userId)}"]`)?.classList.add("active");
  }

  const messages = allHistory.filter(item => item.userId === userId).reverse();

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
    if (item.message) {
      html.push(`
        <div class="bubble-row client-row">
          <div class="bubble client">
            <p>${safe(item.message)}</p>
            <small>${safe(shortTime(item.createdAt))}</small>
          </div>
        </div>
      `);
    }
    if (item.response) {
      html.push(`
        <div class="bubble-row bot-row">
          <div class="bubble bot">
            <p>${safe(item.response)}</p>
            <small>${safe(shortTime(item.createdAt))} ${renderMessageStatus(item.status)}</small>
          </div>
        </div>
      `);
    }
  }

  messagesBox.innerHTML = html.join("");
  // Aguarda render antes de rolar para garantir altura correta
  requestAnimationFrame(() => { messagesBox.scrollTop = messagesBox.scrollHeight; });
}

// ─── Ações de ticket na conversa ─────────────────────────────────────────────
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
    if (ticket) {
      // Reabre ticket existente
      const res = await apiFetch(`${BASE}/api/tickets/${ticket.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ status: "aberto" })
      });
      if (!res?.ok) throw new Error("Erro ao reabrir.");
    } else {
      // Cria novo ticket se não existir nenhum
      const res = await apiFetch(`${BASE}/api/tickets`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ userId, type: "geral", sector: "geral" })
      });
      if (!res?.ok) throw new Error("Erro ao criar atendimento.");
    }
    showToast("✅ Atendimento reaberto!");
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
    onConfirm:   async () => {
      try {
        const res = await apiFetch(`${BASE}/api/tickets/${id}`, {
          method:  "PATCH",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ status: "resolvido" })
        });
        if (!res?.ok) throw new Error("Erro ao fechar.");
        showToast("✅ Atendimento fechado!");
        fecharChat();
        await loadConversations();
        if (currentTab === "metrics") loadMetricsCharts();
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    }
  });
}

async function transferirTicketConv(id) {
  showInputModal({
    title:       "Transferir atendimento",
    label:       "Para qual setor?",
    placeholder: "vendas, financeiro, suporte, garantia",
    confirmText: "Transferir",
    onConfirm:   async (sector) => {
      if (!sector) return;
      const sectorNorm = sector.trim().toLowerCase();
      try {
        const res = await apiFetch(`${BASE}/api/tickets/${id}/transfer`, {
          method: "PATCH",
          body:   JSON.stringify({ sector: sectorNorm })
        });
        if (!res?.ok) throw new Error("Erro ao transferir.");
        showToast("✅ Transferido!");
        await loadConversations();
        if (selectedConversationUser) openConversation(selectedConversationUser);
        if (currentTab === "metrics") loadMetricsCharts();
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    }
  });
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

  // Desabilita botão de envio visualmente durante a requisição
  const sendBtn = document.getElementById("btn-send-conversation");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = "0.5"; }

  const found = quickRepliesCache.find(reply =>
    reply.shortcut.toLowerCase() === message.toLowerCase()
  );
  const finalMessage = found ? found.message : message;

  input.value = "";
  resetTextareaHeight(input);

  try {
    await fetch(`${BASE}/api/messages/typing`, {
      credentials: "include",
      method:  "POST",
      headers: apiHeaders(),
      body:    JSON.stringify({ userId: selectedConversationUser })
    });

    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ userId: selectedConversationUser, message: finalMessage })
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");
    await loadHistory(false);
    await loadConversations();
    if (selectedConversationUser) openConversation(selectedConversationUser);

  } catch (err) {
    showToast(`❌ Erro ao enviar: ${err.message}`);
    if (input) input.value = finalMessage;
  } finally {
    sendingConversationMessage = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.style.opacity = ""; }
  }
}

// ─── Chat rápido (modal legado) ───────────────────────────────────────────────
function abrirChat(userId) {
  currentChatUser = userId;
  document.getElementById("chat-user").textContent = `Cliente: ${formatPhone(userId)}`;
  document.getElementById("chat-message").value    = "";
  document.getElementById("chat-modal").classList.remove("hidden");
}

function fecharChat() {
  document.getElementById("chat-modal").classList.add("hidden");
}

async function enviarMensagemManual() {
  const textarea = document.getElementById("chat-message");
  const message  = textarea?.value?.trim();

  if (!message || !currentChatUser) {
    showToast("Digite uma mensagem antes de enviar.");
    return;
  }

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
  }
}

// ─── Status de mensagem ───────────────────────────────────────────────────────
function renderMessageStatus(status) {
  switch (status) {
    case "read":      return `<i class="fa-solid fa-check-double" style="color:#53bdeb"></i>`;
    case "delivered": return `<i class="fa-solid fa-check-double"></i>`;
    case "sent":      return `<i class="fa-solid fa-check"></i>`;
    default:          return `<i class="fa-solid fa-check"></i>`;
  }
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
let lastTypingAt = 0;

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
