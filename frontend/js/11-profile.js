// 11-profile.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Perfil ───────────────────────────────────────────────────────────────────

function openProfileModal() {
  const user = getCurrentUser();
  if (!user) return;
  
  document.getElementById("profile-name").value  = user.nome   || "";
  document.getElementById("profile-phone").value = user.numero || "";
 document.getElementById("profile-photo-preview").src = safeUrl(user.foto, "/assets/default-avatar.png");
  updateTwoFactorStatusUI();
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
      method:      "PATCH",
      credentials: "include",   // cookie HttpOnly enviado automaticamente
      body:        formData
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

        if (typeof setCurrentUser === "function") setCurrentUser(user);
        else sessionStorage.setItem("current_user", JSON.stringify(user));
        localStorage.setItem(`profile_${user.usuario || user.id}`, JSON.stringify(user));

        // Atualiza avatar no topo da página imediatamente
        applyUserProfileVisual(user);
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

    if (typeof setCurrentUser === "function") setCurrentUser(updatedUser);
    else sessionStorage.setItem("current_user", JSON.stringify(updatedUser));
    localStorage.setItem(`profile_${updatedUser.usuario || updatedUser.id}`, JSON.stringify(updatedUser));

  
    applyUserProfileVisual(updatedUser);
    closeProfileModal();
    showToast("✅ Perfil salvo no servidor!");
  } catch (err) {
    showToast(`❌ ${err.message}`);
  }
}

// ─── Permissões ───────────────────────────────────────────────────────────────
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
    const photo = safeUrl(user.foto);
    avatar.innerHTML = photo ? `<img src="${escapeAttr(photo)}" alt="Perfil">` : safe(initials(name));
  }
}

document
  .getElementById("profile-photo")
  ?.addEventListener("change", previewProfilePhoto);

// ─── 2FA (autenticação de dois fatores) ───────────────────────────────────────
// Gerenciado a partir do modal de perfil. Fluxo: setup (QR code) → confirm
// (código do app) → mostra backup codes uma única vez. Desativar exige senha.

function updateTwoFactorStatusUI() {
  const user      = getCurrentUser();
  const statusLine = document.getElementById("twofa-status-line");
  const actionBtn  = document.getElementById("twofa-action-btn");
  if (!statusLine || !actionBtn) return;

  const enabled = !!user?.totpEnabled;

  statusLine.textContent = enabled
    ? "Ativada — sua conta pede um código a cada login."
    : "Desativada — recomendamos ativar para proteger sua conta.";
  statusLine.classList.toggle("twofa-on", enabled);
  statusLine.classList.toggle("twofa-off", !enabled);

  actionBtn.textContent    = enabled ? "Desativar 2FA" : "Ativar 2FA";
  actionBtn.dataset.action = enabled ? "openTwoFactorDisableStep" : "startTwoFactorSetup";
}

function closeTwoFactorModal() {
  document.getElementById("twofa-modal")?.classList.add("hidden");
  document.querySelectorAll("#twofa-modal .twofa-step").forEach(el => el.classList.add("hidden"));
}

function _showTwoFactorStep(stepId) {
  document.querySelectorAll("#twofa-modal .twofa-step").forEach(el => el.classList.add("hidden"));
  document.getElementById(stepId)?.classList.remove("hidden");
  document.getElementById("twofa-modal")?.classList.remove("hidden");
}

async function startTwoFactorSetup() {
  _showTwoFactorStep("twofa-step-setup");

  const errorEl = document.getElementById("twofa-setup-error");
  const codeEl  = document.getElementById("twofa-setup-code");
  if (errorEl) errorEl.textContent = "";
  if (codeEl) codeEl.value = "";

  try {
    const res = await apiFetch(`${BASE}/api/auth/2fa/setup`, {
      method: "POST",
      body: "{}"
    });
    if (!res) return;

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao iniciar 2FA.");

    const qrImg = document.getElementById("twofa-qr-img");
    if (qrImg) qrImg.src = safeUrl(data.qrCodeDataUrl);

    const secretEl = document.getElementById("twofa-secret-text");
    if (secretEl) secretEl.textContent = data.secret || "";
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
  }
}

async function confirmTwoFactorSetup() {
  const codeEl  = document.getElementById("twofa-setup-code");
  const errorEl = document.getElementById("twofa-setup-error");
  const codigo  = codeEl?.value.trim() || "";

  if (!codigo) {
    if (errorEl) errorEl.textContent = "Digite o código do app.";
    return;
  }

  try {
    const res = await apiFetch(`${BASE}/api/auth/2fa/confirm`, {
      method: "POST",
      body: JSON.stringify({ codigo })
    });
    if (!res) return;

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Código inválido.");

    if (data.user) {
      setCurrentUser(data.user);
      localStorage.setItem(`profile_${data.user.usuario || data.user.id}`, JSON.stringify(data.user));
    }

    renderTwoFactorBackupCodes(data.backupCodes || []);
    _showTwoFactorStep("twofa-step-codes");
    updateTwoFactorStatusUI();
    showToast("✅ 2FA ativado!");
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
  }
}

function renderTwoFactorBackupCodes(codes) {
  const list = document.getElementById("twofa-backup-codes");
  if (!list) return;
  list.innerHTML = codes.map(code => `<li>${safe(code)}</li>`).join("");
}

function finishTwoFactorSetup() {
  closeTwoFactorModal();
}

function openTwoFactorDisableStep() {
  const errorEl = document.getElementById("twofa-disable-error");
  const passEl  = document.getElementById("twofa-disable-password");
  if (errorEl) errorEl.textContent = "";
  if (passEl) passEl.value = "";

  _showTwoFactorStep("twofa-step-disable");
}

async function confirmDisableTwoFactor() {
  const passEl  = document.getElementById("twofa-disable-password");
  const errorEl = document.getElementById("twofa-disable-error");
  const senha   = passEl?.value || "";

  if (!senha) {
    if (errorEl) errorEl.textContent = "Digite sua senha atual.";
    return;
  }

  try {
    const res = await apiFetch(`${BASE}/api/auth/2fa/disable`, {
      method: "POST",
      body: JSON.stringify({ senha })
    });
    if (!res) return;

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erro ao desativar 2FA.");

    if (data.user) {
      setCurrentUser(data.user);
      localStorage.setItem(`profile_${data.user.usuario || data.user.id}`, JSON.stringify(data.user));
    }

    updateTwoFactorStatusUI();
    closeTwoFactorModal();
    showToast("2FA desativado.");
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
  }
}
