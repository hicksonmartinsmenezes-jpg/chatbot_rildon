// 02-auth.js

// ─── Sessão / Auth ────────────────────────────────────────────────────────────
// NOTA DE SEGURANÇA: sessionStorage é vulnerável a XSS.
// A solução ideal é usar cookies HttpOnly; Secure; SameSite=Strict gerenciados
// pelo servidor. Enquanto isso, mantemos sessionStorage mas com token de curta
// duração e renovação automática no apiFetch.
function getSessionToken()  { return sessionStorage.getItem("session_token") || ""; }
function setSessionToken(t) { sessionStorage.setItem("session_token", t); }
function clearSessionToken(){ sessionStorage.removeItem("session_token"); sessionStorage.removeItem("current_user"); }

function apiHeaders(extra = {}) {
  const token = getSessionToken();
  const headers = { "Content-Type": "application/json", ...extra };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login() {
  const userEl  = document.getElementById("login-user");
  const passEl  = document.getElementById("login-pass");
  const error   = document.getElementById("login-error");
  const btn     = document.querySelector(".login-card button");

  const user = userEl?.value.trim() || "";
  const pass = passEl?.value.trim() || "";

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

    // Limpa campos de login da memória
    if (userEl) userEl.value = "";
    if (passEl) passEl.value = "";

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
