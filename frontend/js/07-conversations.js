// 07-conversations.js

// ─── Estado local ─────────────────────────────────────────────────────────────
let activeTicketFilter = "pendentes";
let ticketsByUser      = {}; // userId → ticket mais recente
let humanModeUsers     = new Set(); // userIds em atendimento humano (bot pausado)
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
  return runExclusive("loadConversations", () => _loadConversationsCore(silent));
}

async function _loadConversationsCore(silent = false) {
  const list   = document.getElementById("chat-list");
  const total  = document.getElementById("chat-total");
  const search = document.getElementById("search-conversations")?.value?.trim().toLowerCase() || "";

  if (!silent && list) list.innerHTML = `<p class="loading chat-loading">Carregando...</p>`;

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
      const hoje = new Date().toDateString();
      users = users.filter(uid => {
        const t = ticketsByUser[uid];
        if (!t) return false;
        if (t.status !== "resolvido" && t.status !== "cancelado") return false;
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
      const sectorTag = ticket?.sector
        ? `<span class="conv-sector-tag">${safe(ticket.sector)}</span>`
        : "";
      const statusClass = ticketStatus ? `ci-status-${ticketStatus}` : "";
      const unreadBg = { aberto: "#BA7517", em_andamento: "#185FA5", resolvido: "#1D9E75", cancelado: "#A32D2D" }[ticket?.status] || "#22c55e";

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
              ${unread > 0 ? `<span class="chat-unread" style="background:${unreadBg}">${unread}</span>` : ""}
            </span>
            ${(statusPill || sectorTag) ? `<span class="chat-item-row3">${statusPill}${sectorTag}</span>` : ""}
          </span>
        </button>
      `;
    }).join("");
    bindConversationListDelegation();

    if (selectedConversationUser && users.includes(selectedConversationUser)) {
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

async function openConversation(userId, updateActive = true) {
  _openConvAbort?.abort();
  _openConvAbort = new AbortController();
  const seq = ++_openConvSeq;

  selectedConversationUser = userId;
  const textarea = document.getElementById("conversation-message");
  if (textarea) { textarea.disabled = false; textarea.placeholder = "Digite uma mensagem..."; }
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
    const ticket   = ticketsByUser[userId];

    const actionButtons = buildConversationActionButtons(userId, ticket, humanModeUsers);

    header.innerHTML = `
      <div class="chat-header-profile">
        ${avatarHtml(userId, name, true)}
        <div class="chat-header-info">
          <strong class="chat-contact-name">${safe(name)}</strong>
          ${ticket ? `<span class="chat-ticket-ref">#${safe(ticket.protocolo || ticket.id)} · ${safe(ticket.sector || "geral")}</span>` : ""}
          ${humanModeUsers.has(userId) ? `<span class="chat-bot-paused"><i class="fa-solid fa-headset"></i> Você atendendo · bot pausado</span>` : ""}
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
          <div class="bubble bot"${item.messageId ? ` data-msg-id="${escapeAttr(item.messageId)}"` : ""}>
            <p>${safe(item.response)}</p>
            <small>${safe(shortTime(item.createdAt))} <span class="msg-status">${renderMessageStatus(item.status)}</span></small>
          </div>
        </div>
      `);
    }
  }

  messagesBox.innerHTML = html.join("");
  // Aguarda render antes de rolar para garantir altura correta
  requestAnimationFrame(() => { messagesBox.scrollTop = messagesBox.scrollHeight; });
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
            method: "PATCH",
            body:   JSON.stringify({ toUserId })
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
      body:    JSON.stringify({ userId: selectedConversationUser, message: finalMessage })
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");
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
    dropdown.classList.remove("hidden");
    btn?.setAttribute("aria-expanded", "true");
    // Limpa o dot ao abrir
    document.querySelector(".notification")?.classList.remove("has-alert");
  }
}

function closeNotifDropdown() {
  document.getElementById("notif-dropdown")?.classList.add("hidden");
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
