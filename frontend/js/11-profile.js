// 11-profile.js
// Arquivo modularizado automaticamente a partir do app.js original.

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

document
  .getElementById("profile-photo")
  ?.addEventListener("change", previewProfilePhoto);
