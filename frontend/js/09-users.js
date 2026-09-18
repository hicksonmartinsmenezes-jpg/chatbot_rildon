// 09-users.js

// ─── Usuários do Painel ───────────────────────────────────────────────────────
const PANEL_SCREEN_PERMISSIONS = [
  { id: "dashboard", label: "Dashboard", icon: "fa-desktop", group: "Principal" },
  { id: "conversations", label: "Atendimentos", icon: "fa-headset", group: "Atendimento" },
  { id: "history", label: "Histórico", icon: "fa-clock-rotate-left", group: "Atendimento" },
  { id: "contacts", label: "Contatos", icon: "fa-address-book", group: "Atendimento" },
  { id: "catalogo", label: "Catálogo", icon: "fa-book", group: "Operação" },
  { id: "channels", label: "Campanhas", icon: "fa-bullhorn", group: "Gestão" },
  { id: "metrics", label: "Métricas", icon: "fa-chart-line", group: "Gestão" },
  { id: "chatbot", label: "Chatbot", icon: "fa-robot", group: "Administração" },
  { id: "settings", label: "Configurações", icon: "fa-gear", group: "Administração" }
];

function discoverPanelScreenPermissions() {
  const known = new Set(PANEL_SCREEN_PERMISSIONS.map(screen => screen.id));
  const icons = {
    dashboard: "fa-desktop", conversations: "fa-headset", history: "fa-clock-rotate-left",
    leads: "fa-list", contacts: "fa-address-book", catalogo: "fa-book",
    channels: "fa-bullhorn", metrics: "fa-chart-line", chatbot: "fa-robot", settings: "fa-gear"
  };

  document.querySelectorAll(".sidebar [data-tab]").forEach(el => {
    const id = String(el.dataset.tab || "").trim();
    if (!id || known.has(id)) return;

    const label = el.querySelector(".label")?.textContent?.trim()
      || el.textContent?.trim()
      || id;
    const roleGroup = el.classList.contains("admin-only")
      ? "Administração"
      : el.classList.contains("supervisor-only")
        ? "Gestão"
        : "Painel";

    PANEL_SCREEN_PERMISSIONS.push({
      id,
      label: label.replace(/\s+/g, " "),
      icon: icons[id] || el.querySelector("i")?.className?.split(/\s+/).find(cls => cls.startsWith("fa-")) || "fa-circle",
      group: roleGroup
    });
    known.add(id);
  });

  return PANEL_SCREEN_PERMISSIONS;
}

const DEFAULT_SCREEN_PERMISSIONS = {
  // Perfil = conjunto máximo de telas. As permissões individuais só podem
  // retirar telas desse conjunto, nunca acrescentar uma tela de outro perfil.
  atendente: { dashboard:true, conversations:true, history:true, contacts:true, catalogo:true },
  supervisor: { dashboard:true, conversations:true, history:true, contacts:true, catalogo:true, channels:true, metrics:true },
  admin: Object.fromEntries(PANEL_SCREEN_PERMISSIONS.map(screen => [screen.id, true]))
};

function getUserScreenPermissions(perfil, permissions = {}) {
  const base = { ...(DEFAULT_SCREEN_PERMISSIONS[perfil] || DEFAULT_SCREEN_PERMISSIONS.atendente) };
  if (permissions && Object.keys(permissions).length) {
    PANEL_SCREEN_PERMISSIONS.forEach(screen => {
      if (typeof permissions[screen.id] === "boolean" && screen.id in base) {
        base[screen.id] = permissions[screen.id];
      }
    });
  }
  if (perfil === "admin") return Object.fromEntries(PANEL_SCREEN_PERMISSIONS.map(screen => [screen.id, true]));
  return base;
}

function renderUserPermissionChecklist(containerId, perfil, permissions = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const selected = getUserScreenPermissions(perfil, permissions);
  const allowedByProfile = DEFAULT_SCREEN_PERMISSIONS[perfil] || DEFAULT_SCREEN_PERMISSIONS.atendente;
  const disabledAll = perfil === "admin";
  container.innerHTML = PANEL_SCREEN_PERMISSIONS.map(screen => {
    const available = perfil === "admin" || allowedByProfile[screen.id] === true;
    const checked = selected[screen.id] === true;
    const disabled = disabledAll || !available;
    return (
      '<label class="user-permission-option' +
        (checked ? " is-selected" : "") +
        (!available ? " is-disabled" : "") +
        '">' +
        '<input type="checkbox" value="' + screen.id + '" ' +
          (checked ? "checked" : "") +
          (disabled ? " disabled" : "") + '>' +
        '<span class="user-permission-check"><i class="fa-solid fa-check"></i></span>' +
        '<span class="user-permission-icon"><i class="fa-solid ' + screen.icon + '"></i></span>' +
        '<span class="user-permission-copy"><strong>' + screen.label + '</strong><small>' +
          screen.group + (!available ? " • não disponível neste perfil" : "") +
        '</small></span>' +
      '</label>'
    );
  }).join("");
  container.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener("change", () => input.closest(".user-permission-option")?.classList.toggle("is-selected", input.checked));
  });
}

function readUserScreenPermissions(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return {};
  return Object.fromEntries(PANEL_SCREEN_PERMISSIONS.map(screen => {
    const input = container.querySelector('input[value="' + CSS.escape(screen.id) + '"]');
    return [screen.id, !!input?.checked];
  }));
}

function resetCreateUserPermissions() {
  renderUserPermissionChecklist("user-permissions-list", getValue("user-role") || "atendente");
}

function toggleAllUserPermissions() {
  const container = document.getElementById("user-permissions-list");
  if (!container) return;
  const inputs = [...container.querySelectorAll('input[type="checkbox"]:not(:disabled)')];
  const shouldCheck = inputs.some(input => !input.checked);
  inputs.forEach(input => {
    input.checked = shouldCheck;
    input.closest(".user-permission-option")?.classList.toggle("is-selected", shouldCheck);
  });
}

let editingPermissionsUserId = null;

function openUserPermissionsModal(id) {
  const user = panelUsersCache.find(item => String(item.id) === String(id));
  if (!user) return;
  editingPermissionsUserId = user.id;
  document.getElementById("user-permissions-modal-subtitle").textContent = user.nome + " • " + user.perfil;
  renderUserPermissionChecklist("edit-user-permissions-list", user.perfil, user.permissions);
  document.getElementById("user-permissions-modal")?.classList.remove("hidden");
}

function closeUserPermissionsModal() {
  editingPermissionsUserId = null;
  document.getElementById("user-permissions-modal")?.classList.add("hidden");
}

async function saveUserPermissions() {
  if (!editingPermissionsUserId) return;
  const permissions = readUserScreenPermissions("edit-user-permissions-list");
  try {
    const res = await apiFetch(BASE + "/api/users/" + encodeURIComponent(editingPermissionsUserId) + "/permissions", {
      method: "PATCH",
      body: JSON.stringify({ permissions })
    });
    if (!res) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao salvar permissões.");
    panelUsersCache = panelUsersCache.map(user => String(user.id) === String(data.id) ? { ...user, ...data } : user);
    renderPanelUsers();
    closeUserPermissionsModal();
    showToast("✅ Permissões atualizadas.");
  } catch (err) {
    showToast("❌ " + err.message);
  }
}

let panelUsersCache = [];
let _panelUsersLoading = false;
let _panelUsersRequestId = 0;

function setUsersListState(html) {
  const list = document.getElementById("users-list");
  if (list) list.innerHTML = html;
}

function cssEscapeValue(value) {
  const str = String(value || "");
  return window.CSS?.escape ? CSS.escape(str) : str.replace(/(["\\])/g, "\\$1");
}

async function loadPanelUsers({ silent = false } = {}) {
  const list = document.getElementById("users-list");
  if (!list) return;
  const requestId = ++_panelUsersRequestId;
  if (_panelUsersLoading && silent) return;
  _panelUsersLoading = true;
  if (!silent) list.innerHTML = renderSkeletonList(4);

  try {
    const res = await apiFetch(`${BASE}/api/users`);
    if (!res) return;

    if (res.status === 403) {
      if (requestId === _panelUsersRequestId) list.innerHTML = `<p class="empty">Apenas administradores podem gerenciar usuários.</p>`;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const users = await res.json();
    if (requestId !== _panelUsersRequestId) return;
    panelUsersCache = Array.isArray(users) ? users : [];
    renderPanelUsers();
  } catch {
    if (requestId === _panelUsersRequestId && !silent) {
      list.innerHTML = `
        <div class="contacts-empty">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>Erro ao carregar usuários.</span>
          <button type="button" class="btn-refresh" data-action="loadPanelUsers">Tentar novamente</button>
        </div>`;
    }
  } finally {
    if (requestId === _panelUsersRequestId) _panelUsersLoading = false;
  }
}

function renderPanelUsers() {
  const list = document.getElementById("users-list");
  if (!list) return;

  const activeUsers = panelUsersCache.filter(user => user?.ativo !== false);

  if (!activeUsers.length) {
    list.innerHTML = `<p class="empty">Nenhum usuário cadastrado.</p>`;
    return;
  }

  list.innerHTML = activeUsers.map(user => {
    const online       = window.onlineUsers?.some(u => u.id === user.id && u.online);
    const emAtendimento = Number(user.ticketsAtivos || 0) > 0;
    const foto         = safeUrl(user.foto);
    // Mesmo padrão visual de applyUserProfileVisual() (11-profile.js) — foto
    // se tiver, iniciais do nome caso contrário.
    const avatar       = foto
      ? `<img src="${escapeAttr(foto)}" alt="Foto de ${safe(user.nome)}">`
      : safe(initials(user.nome || user.usuario || "?"));

    return `
    <div class="panel-user-item" data-user-row="${escapeAttr(user.id)}">
      <div class="panel-user-avatar">${avatar}</div>
      <div class="panel-user-info">
        <strong>${safe(user.nome)}</strong>
        <p>
          ${safe(user.usuario)} • ${safe(user.perfil)} •
          ${online ? "🟢 Online" : "⚫ Offline"}
          ${emAtendimento ? " • 🟠 Em atendimento" : ""}
        </p>
      </div>
      <div class="panel-user-actions">
        <button type="button" data-user-action="permissions" data-user-id="${escapeAttr(user.id)}" title="Permissões" aria-label="Permissões">\n          <i class="fa-solid fa-sliders"></i>\n        </button>\n        <button type="button" data-user-action="reset-password" data-user-id="${escapeAttr(user.id)}" title="Alterar senha" aria-label="Alterar senha">
          <i class="fa-solid fa-key"></i>
        </button>
        <button type="button" data-user-action="delete" data-user-id="${escapeAttr(user.id)}" data-user-name="${escapeAttr(user.nome)}" title="Excluir usuário" aria-label="Excluir usuário">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
  `;
  }).join("");
  applyStaggerIn(list);
}

async function createPanelUser() {
  const nome    = getValue("user-name").trim();
  const usuario = getValue("user-username").trim().toLowerCase();
  const numero  = getValue("user-phone").trim();
  const senha   = getValue("user-password").trim();
  const perfil  = getValue("user-role");
  const permissions = readUserScreenPermissions("user-permissions-list");

  if (!nome || !usuario || !senha) { showToast("Preencha nome, usuário e senha."); return; }
  if (!/^\d{4}$/.test(senha)) { showToast("A senha deve ter exatamente 4 dígitos numéricos."); return; }

  const createBtn = document.querySelector('[data-action="createPanelUser"]');
  if (createBtn?.dataset.loading === "1") return;
  if (createBtn) { createBtn.dataset.loading = "1"; createBtn.disabled = true; }

  try {
    const res = await apiFetch(`${BASE}/api/users`, {
      method: "POST",
      body: JSON.stringify({ nome, usuario, senha, perfil, numero, ativo: true, permissions })
    });
    if (!res) throw new Error("Falha de conexão ao criar usuário.");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao criar usuário.");

    panelUsersCache = [data, ...panelUsersCache.filter(u => u.id !== data.id)];
    renderPanelUsers();

    setValue("user-name", ""); setValue("user-username", ""); setValue("user-password", "");
    setValue("user-phone", "");
    setValue("user-role", "atendente");
    resetCreateUserPermissions();
    showToast(data.reactivated ? "✅ Usuário reativado com sucesso!" : "✅ Usuário criado com sucesso!");
    loadPanelUsers({ silent: true });
  } catch (err) {
    showToast(`❌ ${err.message}`);
  } finally {
    if (createBtn) { createBtn.dataset.loading = "0"; createBtn.disabled = false; }
  }
}

// Substitui confirm() nativo por modal estilizado
function confirmDeleteUser(id, nome) {
  showConfirmModal({
    title:       "Excluir usuário",
    message:     `Deseja realmente excluir o usuário "${nome}"? Esta ação não pode ser desfeita.`,
    confirmText: "Excluir",
    danger:      true,
    onConfirm:   () => deletePanelUser(id)
  });
}

async function deletePanelUser(id) {
  const previousUsers = [...panelUsersCache];
  const target = panelUsersCache.find(u => String(u.id) === String(id));
  const row = document.querySelector(`[data-user-row="${cssEscapeValue(id)}"]`);

  if (row) {
    row.classList.add("is-removing");
    row.style.opacity = "0.55";
    row.style.pointerEvents = "none";
  }

  // Atualização imediata na tela para não parecer travado
  panelUsersCache = panelUsersCache.filter(u => String(u.id) !== String(id));
  renderPanelUsers();

  try {
    const res = await apiFetch(`${BASE}/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) throw new Error("Falha de conexão ao excluir usuário.");
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Erro ao excluir usuário.");
    }
    showToast(`Usuário ${target?.nome ? '"' + target.nome + '" ' : ''}excluído.`);
    loadPanelUsers({ silent: true });
  } catch (err) {
    panelUsersCache = previousUsers;
    renderPanelUsers();
    showToast(`❌ ${err.message}`);
  }
}

// Substitui prompt() nativo por modal de senha
function promptResetPassword(id) {
  showInputModal({
    title:       "Alterar senha",
    label:       "Nova senha (PIN de 4 dígitos)",
    placeholder: "Ex: 4821",
    type:        "password",
    confirmText: "Salvar senha",
    onConfirm:   async (novaSenha) => {
      if (!/^\d{4}$/.test(novaSenha)) { showToast("A senha deve ter exatamente 4 dígitos numéricos."); return; }
      try {
        const res = await apiFetch(`${BASE}/api/users/${id}/password`, {
          method: "PATCH",
          body:   JSON.stringify({ senha: novaSenha })
        });
        if (!res) throw new Error("Falha de conexão ao alterar senha.");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erro ao alterar senha.");
        showToast("✅ Senha alterada com sucesso!");
        loadPanelUsers({ silent: true });
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    }
  });
}

// Alias mantido para compatibilidade (caso haja chamadas diretas no HTML)
const resetPanelUserPassword = promptResetPassword;


function initPanelUsersDelegation() {
  const list = document.getElementById("users-list");
  if (!list || list.dataset.delegated === "1") return;
  list.dataset.delegated = "1";
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-user-action]");
    if (!btn || !list.contains(btn)) return;
    const id = btn.dataset.userId || "";
    if (btn.dataset.userAction === "permissions") openUserPermissionsModal(id);
    if (btn.dataset.userAction === "reset-password") promptResetPassword(id);
    if (btn.dataset.userAction === "delete") confirmDeleteUser(id, btn.dataset.userName || "Usuário");
  });
}

function refreshPanelUsersFromSocket() {
  if (currentTab === "settings") loadPanelUsers({ silent: true });
}

document.addEventListener("DOMContentLoaded", () => discoverPanelScreenPermissions());
document.addEventListener("DOMContentLoaded", initPanelUsersDelegation);
document.addEventListener("rildon:users-updated", refreshPanelUsersFromSocket);

document.addEventListener("DOMContentLoaded", () => { resetCreateUserPermissions(); document.getElementById("user-role")?.addEventListener("change", resetCreateUserPermissions); });
