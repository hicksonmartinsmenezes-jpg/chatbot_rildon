// 09-users.js

// ─── Usuários do Painel ───────────────────────────────────────────────────────
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
  if (!silent) list.innerHTML = `<p class="loading">Carregando usuários...</p>`;

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
        <button type="button" data-user-action="reset-password" data-user-id="${escapeAttr(user.id)}" title="Alterar senha" aria-label="Alterar senha">
          <i class="fa-solid fa-key"></i>
        </button>
        <button type="button" data-user-action="delete" data-user-id="${escapeAttr(user.id)}" data-user-name="${escapeAttr(user.nome)}" title="Excluir usuário" aria-label="Excluir usuário">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
  `;
  }).join("");
}

async function createPanelUser() {
  const nome    = getValue("user-name").trim();
  const usuario = getValue("user-username").trim().toLowerCase();
  const numero  = getValue("user-phone").trim();
  const senha   = getValue("user-password").trim();
  const perfil  = getValue("user-role");
  const sector  = getValue("user-sector");

  if (!nome || !usuario || !senha) { showToast("Preencha nome, usuário e senha."); return; }
  if (!/^\d{4}$/.test(senha)) { showToast("A senha deve ter exatamente 4 dígitos numéricos."); return; }

  const createBtn = document.querySelector('[data-action="createPanelUser"]');
  if (createBtn?.dataset.loading === "1") return;
  if (createBtn) { createBtn.dataset.loading = "1"; createBtn.disabled = true; }

  try {
    const res = await apiFetch(`${BASE}/api/users`, {
      method: "POST",
      body: JSON.stringify({ nome, usuario, senha, perfil, sector, numero, ativo: true })
    });
    if (!res) throw new Error("Falha de conexão ao criar usuário.");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Erro ao criar usuário.");

    panelUsersCache = [data, ...panelUsersCache.filter(u => u.id !== data.id)];
    renderPanelUsers();

    setValue("user-name", ""); setValue("user-username", ""); setValue("user-password", "");
    setValue("user-phone", "");
    setValue("user-role", "atendente");
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
    if (btn.dataset.userAction === "reset-password") promptResetPassword(id);
    if (btn.dataset.userAction === "delete") confirmDeleteUser(id, btn.dataset.userName || "Usuário");
  });
}

function refreshPanelUsersFromSocket() {
  if (currentTab === "settings") loadPanelUsers({ silent: true });
}

document.addEventListener("DOMContentLoaded", initPanelUsersDelegation);
document.addEventListener("rildon:users-updated", refreshPanelUsersFromSocket);
