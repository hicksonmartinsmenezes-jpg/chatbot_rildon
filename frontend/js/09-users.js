// 09-users.js

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
          ${safe(user.usuario)} • ${safe(user.perfil)} •
          ${window.onlineUsers?.some(u => u.id === user.id && u.online) ? "🟢 Online" : "⚫ Offline"}
        </p>
      </div>
      <div class="panel-user-actions">
        <button onclick="promptResetPassword('${escapeAttr(user.id)}')" title="Alterar senha">
          <i class="fa-solid fa-key"></i>
        </button>
        <button onclick="confirmDeleteUser('${escapeAttr(user.id)}', '${escapeAttr(user.nome)}')" title="Excluir usuário">
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

// Substitui prompt() nativo por modal de senha
function promptResetPassword(id) {
  showInputModal({
    title:       "Alterar senha",
    label:       "Nova senha",
    placeholder: "Mínimo 4 caracteres",
    type:        "password",
    confirmText: "Salvar senha",
    onConfirm:   async (novaSenha) => {
      if (novaSenha.length < 4) { showToast("A senha deve ter pelo menos 4 caracteres."); return; }
      try {
        const res = await apiFetch(`${BASE}/api/users/${id}/password`, {
          method: "PATCH",
          body:   JSON.stringify({ senha: novaSenha })
        });
        if (!res) return;
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Erro ao alterar senha.");
        showToast("✅ Senha alterada com sucesso!");
      } catch (err) {
        showToast(`❌ ${err.message}`);
      }
    }
  });
}

// Alias mantido para compatibilidade (caso haja chamadas diretas no HTML)
const resetPanelUserPassword = promptResetPassword;
