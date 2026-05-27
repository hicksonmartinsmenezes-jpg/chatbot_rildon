// ─── Estado Global ────────────────────────────────────────────────────────────
const BASE = window.location.origin;

let currentTab             = "dashboard";
let lastTicketTotal        = 0;
let firstLoadTickets       = true;
let selectedConversationUser = null;
let allHistory             = [];
let currentChatUser        = null;
let unreadMessages         = {};
let chartStatus            = null;
let chartSector            = null;
let sendingConversationMessage = false;
let metricDayChart = null;


// ─── Sessão / Auth ────────────────────────────────────────────────────────────
function getSessionToken()  { return sessionStorage.getItem("session_token") || ""; }
function setSessionToken(t) { sessionStorage.setItem("session_token", t); }
function clearSessionToken(){ sessionStorage.removeItem("session_token"); }

function apiHeaders(extra = {}) {
  const token = getSessionToken();
  const headers = { "Content-Type": "application/json", ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login() {
  const user  = document.getElementById("login-user").value.trim();
  const pass  = document.getElementById("login-pass").value.trim();
  const error = document.getElementById("login-error");
  const btn   = document.querySelector(".login-card button");

  if (!user || !pass) { error.textContent = "Preencha usuário e senha."; return; }

  btn.disabled    = true;
  btn.textContent = "Entrando...";
  error.textContent = "";

  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: user, senha: pass })
    });

    const data = await res.json();

    if (!res.ok) { error.textContent = data.error || "Usuário ou senha inválidos."; return; }

    setSessionToken(data.token);
    if (data.user) sessionStorage.setItem("current_user", JSON.stringify(data.user));

    showDashboard();
    applyUserPermissions();
    refreshAll();
  } catch {
    error.textContent = "Erro de conexão. Verifique se o servidor está rodando.";
  } finally {
    btn.disabled    = false;
    btn.textContent = "Entrar";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  ["login-user", "login-pass"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
  });
});

async function logout() {
  try {
    await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: apiHeaders() });
  } catch (_) {}
  clearSessionToken();
  location.reload();
}

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("sidebar").style.display      = "";
  document.getElementById("dashboard").style.display    = "";
}

function checkAuth() {
  if (getSessionToken()) {
    showDashboard();
    applyUserPermissions();
  } else {
    document.getElementById("sidebar").style.display   = "none";
    document.getElementById("dashboard").style.display = "none";
    document.getElementById("login-screen").style.display = "flex";
  }
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
const sidebar = document.getElementById("sidebar");
const btnMenu = document.getElementById("btn-menu");
if (btnMenu) btnMenu.addEventListener("click", () => sidebar.classList.toggle("open"));

// ─── Navegação ────────────────────────────────────────────────────────────────
function switchTab(tab, event) {

  if (tab === "logs") {
    loadActivityLogs();
  }

  if (tab === "metrics") {
    loadTickets();
    setTimeout(() => loadMetricsCharts(), 300);
  }

  currentTab = tab;

  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".sidebar a").forEach(a => a.classList.remove("active"));

  if (event?.currentTarget?.classList.contains("tab")) {
    event.currentTarget.classList.add("active");
  }

  if (event?.currentTarget?.tagName === "A") {
    event.currentTarget.classList.add("active");
    const relatedTab = document.querySelector(`.tab[onclick*="${tab}"]`);
    if (relatedTab) relatedTab.classList.add("active");
  }

  document.querySelectorAll("[id^='tab-']").forEach(s => s.classList.add("hidden"));
  document.getElementById(`tab-${tab}`)?.classList.remove("hidden");

  if (tab === "dashboard") {
  loadTickets();
  loadHistory(false);
}
  if (tab === "tickets")       loadTickets();
  if (tab === "history")       loadHistory(true);
  if (tab === "conversations") loadConversations();
  if (tab === "settings")      { loadSettings(); loadPanelUsers(); }
  if (tab === "chatbot")       { loadSettings(); loadQuickReplies(); }
}

// ─── Atualização Geral ────────────────────────────────────────────────────────
function refreshAll() {
  loadTickets();
  loadHistory(false);
  if (currentTab === "conversations") loadConversations();
}

// ─── Fetch autenticado ────────────────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: apiHeaders(options.headers) });
  if (res.status === 401) {
    clearSessionToken();
    alert("Sua sessão expirou. Faça login novamente.");
    location.reload();
    return null;
  }
  return res;
}

// ─── Tickets ──────────────────────────────────────────────────────────────────
async function loadTickets() {
  const search    = document.getElementById("search")?.value || "";
  const status    = document.getElementById("filter-status")?.value || "";
  const container = document.getElementById("tickets-container");

  if (container) container.innerHTML = `<p class="loading">Carregando atendimentos...</p>`;

  try {
    const params = new URLSearchParams();
    if (search) params.append("search", search);
    if (status) params.append("status", status);

    const res = await apiFetch(`${BASE}/api/tickets?${params}`);
    if (!res) return;
    const data = await res.json();

    updateStats(data.stats, data.tickets || []);

    if (!firstLoadTickets && data.total > lastTicketTotal) showNewTicketAlert();

    lastTicketTotal  = data.total;
    firstLoadTickets = false;

    if (!container) return;

    if (!data.tickets?.length) {
      container.innerHTML = `<p class="empty">Nenhum atendimento encontrado.</p>`;
      return;
    }

    container.innerHTML = data.tickets.map(ticket => `
      <div class="ticket-card ${ticket.status} ${ticket.status === "aberto" ? "novo-ticket" : ""}" id="card-${ticket.id}">
        <div class="ticket-header">
          <span class="ticket-id">#${ticket.protocolo || ticket.id} — ${tipoLabel(ticket.type)}</span>
          <span class="status-badge status-${ticket.status}">${statusLabel(ticket.status)}</span>
        </div>
        <p><strong>👤 Cliente:</strong> ${safe(ticket.customerName || "Não informado")}</p>
        <p><strong>🪪 CPF:</strong> ${safe(ticket.cpf || "Não informado")}</p>
        <p><strong>📱 Número:</strong> ${formatPhone(ticket.userId)}</p>
        <p class="desc"><strong>📋 Descrição:</strong><br>${safe(ticket.description || "—")}</p>
        <p><strong>🕐 Criado em:</strong> ${formatDate(ticket.createdAt)}</p>
        ${ticket.assignedToName ? `<p><strong>👨‍💼 Responsável:</strong> ${safe(ticket.assignedToName)}</p>` : ""}
        <div class="ticket-footer">
          ${!ticket.assignedTo ? `<button class="btn-status btn-andamento" onclick="assumirTicket('${ticket.id}')">Assumir</button>` : ""}
          <button class="btn-status btn-chat" onclick="abrirChat('${escapeAttr(ticket.userId)}')">Responder</button>
          ${ticket.status !== "em_andamento" ? `<button class="btn-status btn-andamento" onclick="mudarStatus('${ticket.id}', 'em_andamento')">Em andamento</button>` : ""}
          ${ticket.status !== "resolvido"    ? `<button class="btn-status btn-resolvido" onclick="mudarStatus('${ticket.id}', 'resolvido')">Resolvido</button>` : ""}
          ${ticket.status !== "cancelado"    ? `<button class="btn-status btn-cancelado" onclick="mudarStatus('${ticket.id}', 'cancelado')">Cancelar</button>` : ""}
          <button class="btn-status" onclick="transferirTicket('${ticket.id}')">Transferir</button>
        </div>
      </div>
    `).join("");
  } catch (err) {
    if (container) container.innerHTML = `<p class="empty">❌ Erro ao carregar atendimentos.</p>`;
  }
}

async function mudarStatus(id, status) {
  try {
    await apiFetch(`${BASE}/api/tickets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
   loadTickets();

if (currentTab === "metrics") {
  loadMetricsCharts();
}
  } catch {
    showToast("Não foi possível atualizar o ticket.");
  }
}

function updateStats(stats, tickets = []) {
  if (!stats) return;
  const total     = stats.total ?? 0;
  const aberto    = stats.aberto ?? stats.abertos ?? 0;
  const andamento = stats.em_andamento ?? 0;
  const resolvido = stats.resolvido ?? stats.resolvidos ?? 0;

  setText("stat-total",    total);
  setText("stat-aberto",   aberto);
  setText("stat-andamento", andamento);
  setText("stat-resolvido", resolvido);
  setText("stat-pendentes", aberto + andamento);
  setText("stat-contatos",  new Set((tickets || []).map(t => t.userId)).size);
}

async function checkServerStatus() {
  try {
    const res = await fetch(`${BASE}/health`, { cache: "no-store" });
    if (!res.ok) throw new Error();
    setOnline();
  } catch {
    setOffline();
  }
}

function playAlertSound(type = "ticket") {
  try {
    const src = type === "message"
      ? "https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg"
      : "https://actions.google.com/sounds/v1/alarms/beep_short.ogg";
    const audio = new Audio(src);
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch (_) {}
}

function showNewTicketAlert() {
  document.querySelector(".notification")?.classList.add("has-alert");
  playAlertSound("ticket");
  showToast("🎫 Novo atendimento recebido!");
}

// ─── Histórico ────────────────────────────────────────────────────────────────
async function loadHistory(render = true) {
  const search    = document.getElementById("search-history")?.value || "";
  const container = document.getElementById("history-container");

  if (render && container) container.innerHTML = `<p class="loading">Carregando histórico...</p>`;

  try {
    const params = new URLSearchParams();
    if (search) params.append("userId", search);
    params.append("limit", "100");

    const res = await apiFetch(`${BASE}/api/history?${params}`);
    if (!res) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const history = Array.isArray(raw) ? raw : [];

    if (render && container) {
      if (!history.length) {
        container.innerHTML = `<p class="empty">Nenhum histórico encontrado.</p>`;
      } else {
        container.innerHTML = history.map(item => `
          <div class="ticket-card">
            <div class="ticket-header">
              <span class="ticket-id">💬 ${formatPhone(item.userId)}</span>
              <span class="status-badge status-em_andamento">Histórico</span>
            </div>
            <p><strong>Mensagem:</strong> ${safe(item.message || "—")}</p>
            <p class="desc"><strong>Resposta:</strong><br>${safe(cutText(item.response || "—", 220))}</p>
            <p><strong>🕐</strong> ${formatDate(item.createdAt)}</p>
          </div>
        `).join("");
      }
    }
    return history;
  } catch {
    if (render && container)
      container.innerHTML = `<p class="empty">❌ Erro ao carregar histórico. Verifique se o servidor está rodando.</p>`;
    return [];
  }
}

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
    allHistory = Array.isArray(raw) ? raw : [];

    if (!list) return;

    const usersSeen = new Set();
    let users = [];
    for (const item of allHistory) {
      if (item?.userId && !usersSeen.has(item.userId)) {
        usersSeen.add(item.userId);
        users.push(item.userId);
      }
    }

    if (search) {
      users = users.filter(userId => {
        const label = contactLabel(userId).toLowerCase();
        const phone = formatPhone(userId).toLowerCase();
        const last  = lastMessage(userId).toLowerCase();
        return label.includes(search) || phone.includes(search) || last.includes(search);
      });
    }

    if (total) total.textContent = `${users.length} ${users.length === 1 ? "conversa" : "conversas"}`;

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
  } catch {
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

function openConversation(userId, updateActive = true) {
  selectedConversationUser    = userId;
  unreadMessages[userId]      = 0;

  const header     = document.getElementById("chat-window-header");
  const messagesBox = document.getElementById("chat-messages");

  if (header) {
    const name = getContactName(userId) || formatPhone(userId);
    header.innerHTML = `
      <div class="chat-header-profile">
        ${avatarHtml(userId, name, true)}
        <div>
          <strong>${safe(contactLabel(userId))}</strong>
          <span>Online</span>
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
  const html = [];

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

  const found        = quickRepliesCache.find(r => r.shortcut.toLowerCase() === message.toLowerCase());
  const finalMessage = found ? found.message : message;

  // Limpa imediatamente (antes da requisição) para evitar envio duplo acidental
  input.value = "";

  try {
    await fetch(`${BASE}/api/messages/typing`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ userId: selectedConversationUser })
    });

    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedConversationUser, message: finalMessage })
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");
  } catch (err) {
    showToast(`❌ Erro ao enviar: ${err.message}`);
    // Restaura a mensagem no campo em caso de falha
    if (input) input.value = finalMessage;
  } finally {
    sendingConversationMessage = false;
  }
}

// ─── Chat rápido (modal) ──────────────────────────────────────────────────────
function abrirChat(userId) {
  currentChatUser = userId;
  document.getElementById("chat-user").textContent    = `Cliente: ${formatPhone(userId)}`;
  document.getElementById("chat-message").value       = "";
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
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ userId: currentChatUser })
    });

    const res = await apiFetch(`${BASE}/api/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentChatUser, message })
    });

    if (!res) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    showToast("✅ Mensagem enviada!");
    textarea.value = "";
    fecharChat();
  } catch (err) {
    showToast(`❌ Erro ao enviar: ${err.message}`);
  }
}

// ─── Configurações ────────────────────────────────────────────────────────────
let currentSettings = null;

const setValue    = (id, v)  => { const el = document.getElementById(id); if (el) el.value   = v ?? ""; };
const setChecked  = (id, v)  => { const el = document.getElementById(id); if (el) el.checked = Boolean(v); };
const getValue    = (id)     => document.getElementById(id)?.value || "";
const getChecked  = (id)     => document.getElementById(id)?.checked ?? false;
const getNumberValue = (id, fallback = 0) => {
  const v = Number(getValue(id));
  return Number.isFinite(v) ? v : fallback;
};

function applyPanelSettings(settings = {}) {
  const { aparencia = {}, empresa = {}, notificacoes = {} } = settings;

  if (aparencia.corPrincipal) document.documentElement.style.setProperty("--primary", aparencia.corPrincipal);
  if (aparencia.corSucesso)   document.documentElement.style.setProperty("--green",   aparencia.corSucesso);

  document.body.classList.toggle("light-theme", aparencia.tema === "light");

  if (aparencia.nomePainel) document.title = aparencia.nomePainel;

  const loginTitle = document.querySelector(".login-card h2");
  if (loginTitle && empresa.nome) loginTitle.textContent = empresa.nome;

  if (notificacoes.mensagemToast) window.DEFAULT_TOAST_MESSAGE = notificacoes.mensagemToast;
}

function fillSettingsForm(s) {
  const { empresa = {}, bot = {}, atendimento = {}, aparencia = {}, notificacoes = {}, historico = {} } = s;

  setValue("set-company-name",    empresa.nome);
  setValue("set-company-phone",   empresa.telefone);
  setValue("set-company-hours",   empresa.horario);
  setValue("set-company-logo",    empresa.logo);
  setValue("set-company-welcome", empresa.mensagemBoasVindas);

  setValue("bot-active",        String(bot.ativo ?? true));
  setValue("bot-welcome",       bot.mensagemBoasVindas   || "");
  setValue("bot-after-hours",   bot.mensagemForaHorario  || "");
  setValue("bot-warning-time",  bot.timeoutAviso         || 3);
  setValue("bot-close-time",    bot.timeoutEncerramento  || 5);
  setValue("bot-close-message", bot.mensagemEncerramento || "");

  setValue("set-human-sectors",     atendimento.setores);
  setValue("set-default-status",    atendimento.statusPadrao || "aberto");
  setValue("set-transfer-message",  atendimento.mensagemTransferencia);

  setValue("set-panel-name",    aparencia.nomePainel);
  setValue("set-primary-color", aparencia.corPrincipal || "#1d6cf5");
  setValue("set-success-color", aparencia.corSucesso   || "#2ecc71");
  setValue("set-theme",         aparencia.tema          || "dark");

  setChecked("set-notification-sound", notificacoes.som);
  setChecked("set-visual-alert",       notificacoes.alertaVisual);
  setValue("set-toast-message",        notificacoes.mensagemToast);

  setValue("set-history-days",   historico.manterDias);
  setValue("set-history-limit",  historico.limiteConversas);
  setValue("set-export-format",  historico.exportacao || "json");
}

function collectSettingsForm() {
  return {
    empresa: {
      nome:               getValue("set-company-name"),
      telefone:           getValue("set-company-phone"),
      horario:            getValue("set-company-hours"),
      logo:               getValue("set-company-logo"),
      mensagemBoasVindas: getValue("set-company-welcome")
    },
    bot: {
      ativo:               getValue("bot-active") === "true",
      mensagemBoasVindas:  getValue("bot-welcome"),
      mensagemForaHorario: getValue("bot-after-hours"),
      timeoutAviso:        getNumberValue("bot-warning-time", 3),
      timeoutEncerramento: getNumberValue("bot-close-time", 5),
      mensagemEncerramento: getValue("bot-close-message"),
      menuPrincipal:       getValue("flow-message"),
      opcoesMenu:          getValue("flow-options")
    },
    atendimento: {
      setores:               getValue("set-human-sectors"),
      statusPadrao:          getValue("set-default-status"),
      mensagemTransferencia: getValue("set-transfer-message")
    },
    aparencia: {
      nomePainel:  getValue("set-panel-name"),
      corPrincipal: getValue("set-primary-color"),
      corSucesso:   getValue("set-success-color"),
      tema:         getValue("set-theme")
    },
    notificacoes: {
      som:           getChecked("set-notification-sound"),
      alertaVisual:  getChecked("set-visual-alert"),
      mensagemToast: getValue("set-toast-message")
    },
    historico: {
      manterDias:       getNumberValue("set-history-days", 90),
      limiteConversas:  getNumberValue("set-history-limit", 100),
      exportacao:       getValue("set-export-format")
    }
  };
}

async function loadSettings() {
  try {
    const res      = await apiFetch(`${BASE}/api/settings`);
    if (!res) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const settings = await res.json();
    currentSettings = settings;
    fillSettingsForm(settings);
    applyPanelSettings(settings);
  } catch {
    showToast("❌ Erro ao carregar configurações.");
  }
}

async function saveSettings() {
  try {
    const res = await apiFetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify(collectSettingsForm())
    });
    if (!res) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = await res.json();
    currentSettings = saved;
    fillSettingsForm(saved);
    applyPanelSettings(saved);
    showToast("✅ Configurações salvas com sucesso!");
  } catch {
    showToast("❌ Erro ao salvar configurações.");
  }
}

async function resetSettings() {
  if (!confirm("Restaurar configurações padrão do painel?")) return;
  try {
    const res = await apiFetch(`${BASE}/api/settings/reset`, { method: "POST" });
    if (!res) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const settings = await res.json();
    currentSettings = settings;
    fillSettingsForm(settings);
    applyPanelSettings(settings);
    showToast("Configurações restauradas.");
  } catch {
    showToast("❌ Erro ao restaurar configurações.");
  }
}

// ─── Status Visual ────────────────────────────────────────────────────────────
function setOnline() {
  const badge = document.getElementById("status-badge");
  if (badge) { badge.textContent = "● Online"; badge.className = "badge badge-ok"; }
}
function setOffline() {
  const badge = document.getElementById("status-badge");
  if (badge) { badge.textContent = "● Offline"; badge.className = "badge badge-off"; }
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
function avatarHtml(userId, name, big = false) {
  return `
    <span class="chat-avatar ${big ? "big" : ""}">
      <img src="${BASE}/api/contacts/photo?userId=${encodeURIComponent(userId)}"
        onerror="this.style.display='none'; this.nextElementSibling.style.display='inline-flex';">
      <span class="avatar-fallback">${safe(initials(name))}</span>
    </span>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

function getContactName(userId) {
  return allHistory.find(h => h.userId === userId && h.contactName)?.contactName || "";
}

function contactLabel(userId) {
  const name  = getContactName(userId);
  const phone = formatPhone(userId);
  return name ? `${name} — ${phone}` : phone;
}

function formatPhone(userId) {
  if (!userId) return "—";
  return String(userId)
    .replace("@s.whatsapp.net", "")
    .replace("@c.us", "")
    .replace("@lid", "");
}

const STATUS_LABELS = { aberto: "Aberto", em_andamento: "Em andamento", resolvido: "Resolvido", cancelado: "Cancelado" };
function statusLabel(status) { return STATUS_LABELS[status] || status || "—"; }

const TIPO_LABELS = {
  suporte_tecnico:      "Suporte Técnico",
  suporte_humano:       "Suporte Humano",
  orcamento:            "Orçamento",
  consultor_vendas:     "Consultor Vendas",
  duvida_financeira:    "Dúvida Financeira",
  atendente_financeiro: "Financeiro Humano",
  atendente_humano:     "Atendente"
};
function tipoLabel(type) { return TIPO_LABELS[type] || type || "Atendimento"; }

function refreshCurrentChatFeed() {
  if (!selectedConversationUser) return;
  openConversation(selectedConversationUser, true);
  const list = document.getElementById("chat-list");
  if (!list) return;
  const activeItem = list.querySelector(`.chat-item[data-user="${cssEscape(selectedConversationUser)}"]`);
  if (!activeItem) return;
  const preview = activeItem.querySelector(".chat-item-bottom span");
  const time    = activeItem.querySelector(".chat-item-top small");
  const last    = getLastHistoryItem(selectedConversationUser);
  if (preview) preview.textContent = lastMessage(selectedConversationUser);
  if (time)    time.textContent    = shortTime(last?.createdAt);
}

function formatDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString("pt-BR");
}

function shortTime(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(value) {
  if (!value) return "Hoje";
  const date      = new Date(value);
  if (Number.isNaN(date.getTime())) return "Hoje";
  const today     = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (sameDate(date, today))     return "Hoje";
  if (sameDate(date, yesterday)) return "Ontem";
  return date.toLocaleDateString("pt-BR");
}

function sameDate(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth()   === b.getMonth()   &&
    a.getDate()    === b.getDate();
}

function initials(value) {
  const clean = String(value || "?").replace(/[^a-zA-ZÀ-ÿ0-9 ]/g, " ").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function cutText(text, max) {
  if (!text) return "—";
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function safe(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return String(value ?? "").replaceAll("'", "&#39;").replaceAll('"', "&quot;");
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/([@.])/g, "\\$1");
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.querySelector("span").textContent = message;
  toast.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
}

// ─── Inicialização ────────────────────────────────────────────────────────────
checkAuth();

if (getSessionToken()) {
  refreshAll();
  const user = getCurrentUser();
  if (user?.perfil === "admin") loadSettings();
}

// Polling automático — não atualiza conversas para não perder o estado do chat
setInterval(() => {
  if (!getSessionToken()) return;
  if (currentTab === "dashboard" || currentTab === "tickets") loadTickets();
  if (currentTab === "history")  loadHistory(true);
}, 15000);

function switchBotPanel(panelId, event) {
  document.querySelectorAll(".bot-panel").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".settings-tab").forEach(t => t.classList.remove("active"));
  document.getElementById(panelId)?.classList.remove("hidden");
  event?.currentTarget?.classList.add("active");
}

const saveBotSettings = () => saveSettings();
const saveFlow        = () => saveSettings();

checkServerStatus();
setInterval(checkServerStatus, 5000);

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
    const alreadyExists = data.messageId && allHistory.some(item => item.messageId === data.messageId);
    if (!alreadyExists) allHistory.unshift(data);

    if (currentTab === "conversations") {
      if (selectedConversationUser === data.userId) openConversation(data.userId, false);
      else loadConversations();
    }

    if (currentTab === "history") loadHistory(true);

   if (currentTab === "dashboard" || currentTab === "tickets") {
  loadTickets();
}

if (currentTab === "metrics") {
  loadMetricsCharts();
}

  
    playAlertSound("message");

    if (data?.userId && selectedConversationUser !== data.userId) {
      unreadMessages[data.userId] = (unreadMessages[data.userId] || 0) + 1;
    }

    if (!data.response || data.message) showToast("💬 Nova mensagem recebida!");
  });

socket.on("typing", data => {
  if (data.from !== "client") return;
  if (selectedConversationUser !== data.userId) return;

  const status = document.getElementById("chat-typing-status");
  if (!status) return;

  status.innerHTML = "Digitando...";

  clearTimeout(window.typingTimeout);

  window.typingTimeout = setTimeout(() => {
    status.innerHTML = "";
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

// ─── Respostas Rápidas ────────────────────────────────────────────────────────
let quickRepliesCache = [];

async function loadQuickReplies() {
  try {
    const res = await apiFetch(`${BASE}/api/quick-replies`);
    if (!res) return;
    quickRepliesCache = await res.json();
    renderQuickReplies();
  } catch {
    showToast("❌ Erro ao carregar respostas rápidas.");
  }
}

function renderQuickReplies() {
  const list = document.getElementById("quick-replies-list");
  if (!list) return;

  if (!quickRepliesCache.length) {
    list.innerHTML = `<p class="empty">Nenhuma resposta rápida cadastrada.</p>`;
    return;
  }

  list.innerHTML = quickRepliesCache.map(reply => `
    <div class="quick-reply-item">
      <div>
        <strong>${safe(reply.shortcut)}</strong>
        <p>${safe(reply.message)}</p>
      </div>
      <button onclick="deleteQuickReply('${escapeAttr(reply.id)}')" title="Excluir">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `).join("");
}

async function addQuickReply() {
  const shortcut = getValue("quick-shortcut").trim();
  const message  = getValue("quick-message").trim();

  if (!shortcut || !message) { showToast("Preencha atalho e mensagem."); return; }

  quickRepliesCache.push({
    id:       crypto.randomUUID?.() ?? String(Date.now()),
    shortcut: shortcut.startsWith("/") ? shortcut : `/${shortcut}`,
    message
  });

  await saveQuickReplies();
  setValue("quick-shortcut", "");
  setValue("quick-message",  "");
}

async function deleteQuickReply(id) {
  quickRepliesCache = quickRepliesCache.filter(r => r.id !== id);
  await saveQuickReplies();
}

async function saveQuickReplies() {
  try {
    const res = await apiFetch(`${BASE}/api/quick-replies`, {
      method: "PUT",
      body: JSON.stringify(quickRepliesCache)
    });
    if (!res || !res.ok) throw new Error("Erro ao salvar.");
    quickRepliesCache = await res.json();
    renderQuickReplies();
    showToast("✅ Respostas rápidas salvas!");
  } catch {
    showToast("❌ Erro ao salvar respostas rápidas.");
  }
}

// ─── Usuários do Painel ───────────────────────────────────────────────────────
let panelUsersCache = [];

async function loadPanelUsers() {
  const list = document.getElementById("users-list");
  if (!list) return;
  list.innerHTML = `<p class="loading">Carregando usuários...</p>`;

  try {
    const res = await apiFetch(`${BASE}/api/users`);
    if (!res) return;

    if (res.status === 403) {
      list.innerHTML = `<p class="empty">Apenas administradores podem gerenciar usuários.</p>`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    panelUsersCache = await res.json();
    renderPanelUsers();
  } catch {
    list.innerHTML = `<p class="empty">Erro ao carregar usuários.</p>`;
  }
}

function renderPanelUsers() {
  const list = document.getElementById("users-list");
  if (!list) return;

  if (!panelUsersCache.length) {
    list.innerHTML = `<p class="empty">Nenhum usuário cadastrado.</p>`;
    return;
  }

  list.innerHTML = panelUsersCache.map(user => `
    <div class="panel-user-item">
      <div>
        <strong>${safe(user.nome)}</strong>
      <p>

  ${safe(user.usuario)}
  •
  ${safe(user.perfil)}
  •

  ${
    window.onlineUsers?.some(u => u.id === user.id && u.online)
      ? "🟢 Online"
      : "⚫ Offline"
  }

</p>
      </div>
      <div class="panel-user-actions">
        <button onclick="resetPanelUserPassword('${escapeAttr(user.id)}')" title="Alterar senha">
          <i class="fa-solid fa-key"></i>
        </button>
        <button onclick="deletePanelUser('${escapeAttr(user.id)}')" title="Excluir usuário">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
  `).join("");
}

async function createPanelUser() {
  const nome    = getValue("user-name").trim();
  const usuario = getValue("user-username").trim();
  const senha   = getValue("user-password").trim();
  const perfil  = getValue("user-role");
  const sector  = getValue("user-sector");

  if (!nome || !usuario || !senha) { showToast("Preencha nome, usuário e senha."); return; }

  try {
    const res = await apiFetch(`${BASE}/api/users`, {
      method: "POST",
      body: JSON.stringify({ nome, usuario, senha, perfil, sector, ativo: true })
    });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao criar usuário.");

    setValue("user-name", ""); setValue("user-username", ""); setValue("user-password", "");
    setValue("user-role", "atendente");
    showToast("✅ Usuário criado com sucesso!");
    loadPanelUsers();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function deletePanelUser(id) {
  if (!confirm("Deseja excluir este usuário?")) return;
  try {
    const res = await apiFetch(`${BASE}/api/users/${id}`, { method: "DELETE" });
    if (!res) return;
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Erro ao excluir usuário.");
    }
    showToast("Usuário excluído.");
    loadPanelUsers();
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function resetPanelUserPassword(id) {
  const novaSenha = prompt("Digite a nova senha para este usuário:");
  if (!novaSenha) return;
  if (novaSenha.length < 4) { showToast("A senha deve ter pelo menos 4 caracteres."); return; }

  try {
    const res = await apiFetch(`${BASE}/api/users/${id}/password`, {
      method: "PATCH",
      body: JSON.stringify({ senha: novaSenha })
    });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao alterar senha.");
    showToast("✅ Senha alterada com sucesso!");
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// ─── Assumir / Transferir Ticket ─────────────────────────────────────────────
async function assumirTicket(id) {
  try {
    const res = await apiFetch(`${BASE}/api/tickets/${id}/assign`, { method: "PATCH" });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao assumir ticket.");

    showToast("✅ Ticket assumido!");

    if (data.ticket?.userId) {
      currentTab = "conversations";
      switchTab("conversations");
      await loadConversations();
      openConversation(data.ticket.userId);
    } else {
      loadTickets();
      if (currentTab === "metrics") {
  loadMetricsCharts();
}
    }
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

async function transferirTicket(id) {
  const sector = prompt("Transferir para qual setor?\n\nvendas\nfinanceiro\nsuporte\ngarantia");
  if (!sector) return;

  try {
    const res = await apiFetch(`${BASE}/api/tickets/${id}/transfer`, {
      method: "PATCH",
      body: JSON.stringify({ sector })
    });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao transferir ticket.");
    showToast("✅ Ticket transferido!");
    loadTickets();
    if (currentTab === "metrics") {
  loadMetricsCharts();
}
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// ─── Gráficos ─────────────────────────────────────────────────────────────────
async function loadDashboardCharts() {
  if (typeof Chart === "undefined") return;

  const user = getCurrentUser();
  if (!["admin", "supervisor"].includes(user?.perfil)) return;

  try {
    const res = await apiFetch(`${BASE}/api/tickets/dashboard`);
    if (!res) return;
    const data = await res.json();

    const statusCanvas = document.getElementById("chart-status");
    const sectorCanvas = document.getElementById("chart-sector");
    if (!statusCanvas || !sectorCanvas) return;

    if (chartStatus) chartStatus.destroy();
    if (chartSector) chartSector.destroy();

    chartStatus = new Chart(statusCanvas, {
      type: "doughnut",
      data: {
        labels: Object.keys(data.porStatus || {}),
        datasets: [{ data: Object.values(data.porStatus || {}) }]
      }
    });

    chartSector = new Chart(sectorCanvas, {
      type: "bar",
      data: {
        labels: Object.keys(data.porSetor || {}),
        datasets: [{ label: "Atendimentos", data: Object.values(data.porSetor || {}) }]
      }
    });
  } catch (_) {}
}

// ─── Status de Mensagem ───────────────────────────────────────────────────────
function renderMessageStatus(status) {
  switch (status) {
    case "read":      return `<i class="fa-solid fa-check-double" style="color:#53bdeb"></i>`;
    case "delivered": return `<i class="fa-solid fa-check-double"></i>`;
    case "sent":      return `<i class="fa-solid fa-check"></i>`;
    default:          return `<i class="fa-regular fa-clock"></i>`;
  }
}

// ─── Perfil ───────────────────────────────────────────────────────────────────

function openProfileModal() {
  const user = getCurrentUser();
  if (!user) return;
  
  document.getElementById("profile-name").value  = user.nome   || "";
  document.getElementById("profile-phone").value = user.numero || "";
 document.getElementById("profile-photo-preview").src =  user.foto || "/assets/default-avatar.png";
  document.getElementById("profile-modal").classList.remove("hidden");
}

function closeProfileModal() {
  document.getElementById("profile-modal").classList.add("hidden");
}

async function previewProfilePhoto(event) {

  const file = event.target.files[0];

  if (!file) return;

  try {

    const formData = new FormData();

    formData.append("foto", file);

    const response = await fetch("/api/auth/me/photo", {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${getSessionToken()}`
      },
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Erro ao enviar foto.");
    }

    if (data.foto) {

      document.getElementById("profile-photo-preview").src = data.foto;

      const user = getCurrentUser();

      if (user) {

        user.foto = data.foto;

        sessionStorage.setItem(
          "current_user",
          JSON.stringify(user)
        );

        localStorage.setItem(
          `profile_${user.usuario || user.id}`,
          JSON.stringify(user)
        );
      }

      showToast("✅ Foto atualizada!");
    }

  } catch (err) {

    showToast(`❌ ${err.message}`);
  }
}
async function saveProfile() {
  const user = getCurrentUser();
  if (!user) return;

  const payload = {
  nome: document.getElementById("profile-name").value.trim(),
  numero: document.getElementById("profile-phone").value.trim(),
  foto: user.foto || ""
};

  try {
    const res = await apiFetch(`${BASE}/api/auth/me/profile`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });

    if (!res) return;

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao salvar perfil.");

    const updatedUser = data.user;

    sessionStorage.setItem("current_user", JSON.stringify(updatedUser));
    localStorage.setItem(`profile_${updatedUser.usuario || updatedUser.id}`, JSON.stringify(updatedUser));

  
    applyUserProfileVisual(updatedUser);
    closeProfileModal();
    showToast("✅ Perfil salvo no servidor!");
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// ─── Permissões ───────────────────────────────────────────────────────────────
function getCurrentUser() {
  try {
    const sessionUser = JSON.parse(sessionStorage.getItem("current_user") || "null");
    if (!sessionUser) return null;
    const saved = JSON.parse(localStorage.getItem(`profile_${sessionUser.usuario || sessionUser.id}`) || "null");
    return saved || sessionUser;
  } catch { return null; }
}

function applyUserPermissions() {
  const user = getCurrentUser();
  if (!user) return;
  const perfil = user.perfil;
  document.querySelectorAll(".admin-only").forEach(el => {
    el.style.display = perfil === "admin" ? "" : "none";
  });
  document.querySelectorAll(".supervisor-only").forEach(el => {
    el.style.display = ["admin", "supervisor"].includes(perfil) ? "" : "none";
  });
  applyUserProfileVisual(user);
}

function applyUserProfileVisual(user) {
  const name    = user.nome || user.usuario || "Usuário";
  const topName = document.getElementById("top-user-name");
  const avatar  = document.getElementById("top-user-avatar");
  if (topName) topName.textContent = name;
  if (avatar) {
    avatar.innerHTML = user.foto ? `<img src="${user.foto}" alt="Perfil">` : initials(name);
  }
}

async function loadActivityLogs() {

  const container =
    document.getElementById("logs-container");

  if (!container) return;

  container.innerHTML =
    `<p class="loading">Carregando logs...</p>`;

  try {

    const res =
      await apiFetch(`${BASE}/api/activity-logs`);

    if (!res) return;

    const logs = await res.json();

    if (!logs.length) {

      container.innerHTML =
        `<p class="empty">Nenhum log encontrado.</p>`;

      return;
    }

    container.innerHTML = logs.map(log => `

      <div class="ticket-card">

        <div class="ticket-header">

          <span class="ticket-id">
            ${log.action}
          </span>

          <span class="status-badge status-em_andamento">
            ${new Date(log.createdAt)
              .toLocaleString("pt-BR")}
          </span>

        </div>

        <p>
          <strong>Usuário:</strong>
          ${log.userName}
        </p>

        <p class="desc">
          <strong>Ação:</strong><br>
          ${log.description}
        </p>

      </div>

    `).join("");

  } catch (err) {

    console.error(err);

    container.innerHTML =
      `<p class="empty">Erro ao carregar logs.</p>`;
  }
}

let typingTimer = null;

let lastTypingAt = 0;

function notifyTyping() {
  if (!selectedConversationUser) return;

  const now = Date.now();

  if (now - lastTypingAt < 1200) return;

  lastTypingAt = now;

  fetch(`${BASE}/api/messages/typing`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify({
      userId: selectedConversationUser
    })
  }).catch(() => {});
}


async function loadMetricsCharts() {
  if (typeof Chart === "undefined") return;

  try {
    const res = await apiFetch(`${BASE}/api/metrics`);
    if (!res) return;

    const data = await res.json();

    const total = document.getElementById("metric-total");
    const andamento = document.getElementById("metric-andamento");
    const resolvidos = document.getElementById("metric-resolvidos");
    const cancelados = document.getElementById("metric-cancelados");

    if (total) total.innerHTML = data.total || 0;
    if (andamento) andamento.innerHTML = data.andamento || 0;
    if (resolvidos) resolvidos.innerHTML = data.resolvidos || 0;
    if (cancelados) cancelados.innerHTML = data.cancelados || 0;

    const statusCanvas = document.getElementById("metric-chart-status");

    if (statusCanvas) {
      if (window.metricStatusChart) {
        window.metricStatusChart.destroy();
      }

      window.metricStatusChart = new Chart(statusCanvas, {
        type: "doughnut",
        data: {
          labels: Object.keys(data.porStatus || {}),
          datasets: [{
            data: Object.values(data.porStatus || {}),
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

    const sectorCanvas = document.getElementById("metric-chart-sector");

    if (sectorCanvas) {
      if (window.metricSectorChart) {
        window.metricSectorChart.destroy();
      }

      window.metricSectorChart = new Chart(sectorCanvas, {
        type: "bar",
        data: {
          labels: Object.keys(data.porSetor || {}),
          datasets: [{
            label: "Atendimentos",
            data: Object.values(data.porSetor || {}),
            borderRadius: 10
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

    const dayCanvas = document.getElementById("metric-chart-day");

    if (dayCanvas) {
      if (metricDayChart) {
        metricDayChart.destroy();
      }

      metricDayChart = new Chart(dayCanvas, {
        type: "line",
        data: {
          labels: Object.keys(data.porDia || {}),
          datasets: [{
            label: "Atendimentos por dia",
            data: Object.values(data.porDia || {}),
            tension: 0.35,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

  } catch (err) {
    console.error("Erro métricas:", err);
  }
}

document
  .getElementById("profile-photo")
  ?.addEventListener("change", previewProfilePhoto);