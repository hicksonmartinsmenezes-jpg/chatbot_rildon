// 08-settings.js
// Arquivo modularizado automaticamente a partir do app.js original.


// ─── Navegação visual da Central de Configurações ─────────────────────────────
const SETTINGS_PANEL_TITLES = {
  usuarios: "Usuários do painel",
  empresa: "Dados da empresa",
  atendimento: "Atendimento humano",
  aparencia: "Aparência",
  notificacoes: "Notificações",
  historico: "Histórico",
  whatsapp: "Conexão WhatsApp"
};

function openSettingsPanel(panelName) {
  const home = document.getElementById("settings-home");
  const grid = document.getElementById("settings-detail-grid");
  const toolbar = document.getElementById("settings-panel-toolbar");
  const title = document.getElementById("settings-panel-title");

  if (!grid) return;

  home?.classList.add("hidden");
  toolbar?.classList.remove("hidden");
  grid.classList.remove("hidden");
  grid.classList.add("single-panel");

  document.querySelectorAll("[data-settings-panel]").forEach(card => {
    card.classList.toggle("hidden", card.dataset.settingsPanel !== panelName);
  });

  if (title) {
    title.textContent = SETTINGS_PANEL_TITLES[panelName] || "Configurações";
  }

  if (panelName === "usuarios" && typeof loadPanelUsers === "function") {
    loadPanelUsers({ silent: panelUsersCache?.length > 0 });
  }

  // Ao abrir o painel WhatsApp, busca status/QR pendente (evento socket é efêmero)
  if (panelName === "whatsapp" && typeof loadWaStatus === "function") {
    loadWaStatus();
  }
}

// Pedido do usuário (2026-08-05): abas na Central de Configurações (mesmo
// padrão visual usado em Métricas) agrupando as 7 categorias que já
// existiam — Atendimento/WhatsApp/Notificações, Usuários/Empresa,
// Aparência/Histórico. Usa data-settings-home-tab (não data-settings-panel,
// que já é o atributo dos formulários de detalhe abertos por
// openSettingsPanel — nomes diferentes de propósito pra não colidir).
function switchSettingsTab(tab) {
  document.querySelectorAll(".settings-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.settingsTab === tab);
  });
  document.querySelectorAll("[data-settings-home-tab]").forEach(panel => {
    panel.classList.toggle("hidden", panel.dataset.settingsHomeTab !== tab);
  });
}

function backToSettingsHome() {
  const home = document.getElementById("settings-home");
  const grid = document.getElementById("settings-detail-grid");
  const toolbar = document.getElementById("settings-panel-toolbar");

  home?.classList.remove("hidden");
  toolbar?.classList.add("hidden");
  grid?.classList.add("hidden");
  grid?.classList.remove("single-panel");

  document.querySelectorAll("[data-settings-panel]").forEach(card => {
    card.classList.remove("hidden");
  });
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

  // Preferência local do usuário (botão de tema) tem prioridade sobre o tema global do admin
  const localTheme = (typeof getStoredTheme === "function") ? getStoredTheme() : null;
  applyTheme(localTheme || (aparencia.tema === "light" ? "light" : "dark"));

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
  setValue("set-reopen-window-minutes", atendimento.tempoReaberturaSemPesquisa || 60);

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
      mensagemTransferencia: getValue("set-transfer-message"),
      tempoReaberturaSemPesquisa: getNumberValue("set-reopen-window-minutes", 60)
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

function resetSettings() {
  showConfirmModal({
    title:       "Restaurar configurações",
    message:     "Restaurar as configurações padrão do painel? Esta ação sobrescreverá todas as configurações atuais.",
    confirmText: "Restaurar",
    danger:      true,
    onConfirm:   async () => {
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
  });
}

// ─── Toggle rápido do bot (visível para QUALQUER atendente, não só admin) ────
// Pedido do usuário (2026-07-24): todo atendente deve poder ligar/desligar o
// bot direto da topbar, sem precisar de acesso à Central de Configurações
// (essa continua admin-only). Usa /api/bot-status, uma rota enxuta separada
// de /api/settings — ver src/routes/botStatus.routes.js.
window.botAtivoAtual = true;

function renderBotToggleStatus(ativo) {
  window.botAtivoAtual = ativo;
  const btn = document.getElementById("bot-toggle-btn");
  if (!btn) return;
  btn.classList.toggle("bot-off", !ativo);
  btn.title = ativo ? "Bot ativo — clique para desligar" : "Bot desativado — clique para ligar";
}

async function loadBotToggleStatus() {
  try {
    const res = await apiFetch(`${BASE}/api/bot-status`);
    if (!res?.ok) return;
    const { ativo } = await res.json();
    renderBotToggleStatus(ativo !== false);
  } catch (_) {}
}

async function toggleBotStatus() {
  const novoValor = !window.botAtivoAtual;

  const doToggle = async () => {
    try {
      const res = await apiFetch(`${BASE}/api/bot-status`, {
        method: "PUT",
        headers: apiHeaders(),
        body: JSON.stringify({ ativo: novoValor })
      });
      if (!res) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { ativo } = await res.json();
      renderBotToggleStatus(ativo !== false);
      showToast(ativo ? "🤖 Bot ativado." : "🤖 Bot desativado.");
    } catch (err) {
      showToast(`❌ Erro ao alterar status do bot: ${err.message}`);
    }
  };

  const message = novoValor
    ? "O bot vai voltar a responder automaticamente TODOS os clientes. Continuar?"
    : "O bot vai parar de responder automaticamente TODOS os clientes (afeta todo mundo, não só esta conversa). Continuar?";

  if (typeof showConfirmModal === "function") {
    showConfirmModal({
      title:       novoValor ? "Ativar o bot" : "Desativar o bot",
      message,
      confirmText: novoValor ? "Ativar" : "Desativar",
      cancelText:  "Cancelar",
      danger:      !novoValor,
      onConfirm:   doToggle
    });
    return;
  }

  if (!confirm(message)) return;
  return doToggle();
}

// ─── Respostas Rápidas ────────────────────────────────────────────────────────
let quickRepliesCache = [];

async function loadQuickReplies() {
  try {
    const res = await apiFetch(`${BASE}/api/quick-replies`);
    if (!res?.ok) return;
    const raw = await res.json();
    quickRepliesCache = Array.isArray(raw) ? raw : [];
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
      <button type="button" data-quick-action="delete" data-quick-id="${escapeAttr(reply.id)}" title="Excluir" aria-label="Excluir resposta rápida">
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
      method:  "PUT",
      headers: apiHeaders(),
      body:    JSON.stringify(quickRepliesCache)
    });
    if (!res || !res.ok) throw new Error("Erro ao salvar.");
    quickRepliesCache = await res.json();
    renderQuickReplies();
    showToast("✅ Respostas rápidas salvas!");
  } catch {
    showToast("❌ Erro ao salvar respostas rápidas.");
  }
}


function initQuickRepliesDelegation() {
  const list = document.getElementById("quick-replies-list");
  if (!list || list.dataset.delegated === "1") return;
  list.dataset.delegated = "1";
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-quick-action='delete']");
    if (!btn || !list.contains(btn)) return;
    deleteQuickReply(btn.dataset.quickId || "");
  });
}

document.addEventListener("DOMContentLoaded", initQuickRepliesDelegation);
