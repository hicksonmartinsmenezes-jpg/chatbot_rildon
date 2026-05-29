// 08-settings.js
// Arquivo modularizado automaticamente a partir do app.js original.


// ─── Navegação visual da Central de Configurações ─────────────────────────────
const SETTINGS_PANEL_TITLES = {
  usuarios: "Usuários do painel",
  empresa: "Dados da empresa",
  atendimento: "Atendimento humano",
  aparencia: "Aparência",
  notificacoes: "Notificações",
  historico: "Histórico"
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
