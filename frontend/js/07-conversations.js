// 07-conversations.js

// ─── Conversas ────────────────────────────────────────────────────────────────
async function loadConversations() {
  const list   = document.getElementById("chat-list");
  const total  = document.getElementById("chat-total");
  const search = document.getElementById("search-conversations")?.value?.trim().toLowerCase() || "";

  if (list) list.innerHTML = `<p class="loading chat-loading">Carregando conversas...</p>`;

  try {
    const params = new URLSearchParams();
    params.append("limit", "100");

    const res = await apiFetch(`${BASE}/api/history?${params}`);
    if (!res) return;

    const raw = await res.json();
    allHistory = Array.isArray(raw) ? raw : raw.data || [];

    if (!list) return;

    const usersSeen = new Set();
    let users = [];

    for (const item of allHistory) {
      if (item?.userId && !usersSeen.has(item.userId)) {
        usersSeen.add(item.userId);
        users.push(item.userId);
      }
    }

    // Ordena conversas pela última atividade, estilo WhatsApp/CRM
    users.sort((a, b) => {
      const aLast = getLastHistoryItem(a);
      const bLast = getLastHistoryItem(b);

      return (
        new Date(bLast?.createdAt || 0) -
        new Date(aLast?.createdAt || 0)
      );
    });

    if (search) {
    users = users.filter(userId => {
      const userHistory = allHistory.filter(item => item.userId === userId);

      const searchableText = userHistory.map(item => [
        contactLabel(userId),
        formatPhone(userId),
        item.contactName,
        item.message,
        item.response,
        item.sector,
        item.status
      ].filter(Boolean).join(" ")).join(" ").toLowerCase();

      return searchableText.includes(search);
    });
  }

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

            <em>${safe(formatPhone(userId))}</em>
          </span>
        </button>
      `;
    }).join("");

    if (selectedConversationUser && users.includes(selectedConversationUser)) {
      openConversation(selectedConversationUser, true);
    }

  } catch (err) {
    console.error("Erro ao carregar conversas:", err);

    if (list) {
      list.innerHTML = `<p class="empty chat-empty">❌ Erro ao carregar conversas.</p>`;
    }
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

function openConversation(userId, updateActive = true) {
  selectedConversationUser = userId;
  const hadUnread =
  unreadMessages[userId] > 0;

  unreadMessages[userId] = 0;

if (hadUnread && updateActive) {
  setTimeout(() => loadConversations(), 100);
}

  const header      = document.getElementById("chat-window-header");
  const messagesBox = document.getElementById("chat-messages");

  if (header) {
    const name = getContactName(userId) || formatPhone(userId);

    const isOnline = window.onlineUsers?.some(u => u.userId === userId);
    const statusText =
    isOnline
      ? "🟢 Online"
      : "⚫ Offline";

      header.innerHTML = `
    <div class="chat-header-profile">
      ${avatarHtml(userId, name, true)}

      <div>
        <strong>${safe(contactLabel(userId))}</strong>

        <span class="contact-status">
          ${safe(statusText)}
        </span>

        <div id="chat-typing-status"></div>
      </div>
    </div>

    <div class="chat-header-actions">
      <button title="Atualizar" onclick="loadConversations()">
        <i class="fa-solid fa-rotate-right"></i>
      </button>
    </div>
  `;
  }

  if (updateActive) {
    document.querySelectorAll(".chat-item").forEach(item => {
      item.classList.remove("active");
    });

    document
      .querySelector(`.chat-item[data-user="${cssEscape(userId)}"]`)
      ?.classList.add("active");
  }

  const messages = allHistory
    .filter(item => item.userId === userId)
    .reverse();

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
            <small>
              ${safe(shortTime(item.createdAt))}
              ${renderMessageStatus(item.status)}
            </small>
          </div>
        </div>
      `);
    }
  }

  messagesBox.innerHTML = html.join("");
  messagesBox.scrollTop = messagesBox.scrollHeight;
}

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

  sendingConversationMessage = true;

  const found = quickRepliesCache.find(reply =>
    reply.shortcut.toLowerCase() === message.toLowerCase()
  );

  const finalMessage = found ? found.message : message;

  input.value = "";

  try {
    await fetch(`${BASE}/api/messages/typing`, {
      method:  "POST",
      headers: apiHeaders(),
      body:    JSON.stringify({ userId: selectedConversationUser })
    });

    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        userId: selectedConversationUser,
        message: finalMessage
      })
    });

    if (!res) return;

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");

    await loadHistory(false);
    await loadConversations();

    if (selectedConversationUser) {
      openConversation(selectedConversationUser);
    }

  } catch (err) {
    showToast(`❌ Erro ao enviar: ${err.message}`);

    if (input) {
      input.value = finalMessage;
    }

  } finally {
    sendingConversationMessage = false;
  }
}

// ─── Chat rápido (modal) ──────────────────────────────────────────────────────
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
      method:  "POST",
      headers: apiHeaders(),
      body:    JSON.stringify({ userId: currentChatUser })
    });

    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        userId: currentChatUser,
        message
      })
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

// ─── Status de Mensagem ───────────────────────────────────────────────────────
function renderMessageStatus(status) {
  switch (status) {
    case "read":
      return `<i class="fa-solid fa-check-double" style="color:#53bdeb"></i>`;

    case "delivered":
      return `<i class="fa-solid fa-check-double"></i>`;

    case "sent":
      return `<i class="fa-solid fa-check"></i>`;

    default:
      return `<i class="fa-regular fa-clock"></i>`;
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
    method:  "POST",
    headers: apiHeaders(),
    body:    JSON.stringify({ userId: selectedConversationUser })
  }).catch(() => {});
}