// 02-auth.js
// Sessão gerenciada via cookie HttpOnly — o navegador envia automaticamente.
// O JS do cliente nunca vê nem armazena o token de sessão.

// ─── Usuário em memória (apenas dados públicos, sem token) ────────────────────
let _currentUser = null;

function getCurrentUser() {
  if (_currentUser) return _currentUser;
  try {
    const raw = sessionStorage.getItem("current_user");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function setCurrentUser(user) {
  _currentUser = user;
  if (user) sessionStorage.setItem("current_user", JSON.stringify(user));
  else sessionStorage.removeItem("current_user");
}

// ─── Headers da API — sem token, cookie é enviado automaticamente ─────────────
function apiHeaders(extra = {}, body = null) {
  const headers = { ...(extra || {}) };

  // FormData precisa deixar o navegador definir o boundary automaticamente.
  // Se setar Content-Type manualmente, uploads podem quebrar.
  if (body instanceof FormData) {
    delete headers["Content-Type"];
    delete headers["content-type"];
    return headers;
  }

  return { "Content-Type": "application/json", ...headers };
}

// ─── Fetch autenticado — sempre com credentials: "include" para enviar cookie ─
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    credentials: "include",              // envia o cookie HttpOnly automaticamente
    headers: apiHeaders(options.headers, options.body)
  });

  if (res.status === 401) {
    showSessionExpired();
    return res;
  }

  return res;
}

// ─── Toggle de visibilidade da senha ─────────────────────────────────────────
function togglePasswordVisibility() {
  const passEl = document.getElementById("login-pass");
  const iconEl = document.getElementById("toggle-pass-icon");
  if (!passEl) return;
  const isHidden = passEl.type === "password";
  passEl.type    = isHidden ? "text" : "password";
  if (iconEl) iconEl.className = isHidden ? "fa-solid fa-eye-slash" : "fa-solid fa-eye";
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login() {
  const userEl = document.getElementById("login-user");
  const passEl = document.getElementById("login-pass");
  const error  = document.getElementById("login-error");
  const btn    = document.querySelector(".login-card button[type='submit']");

  const usuario = userEl?.value.trim() || "";
  const senha   = passEl?.value || "";

  if (!usuario || !senha) {
    error.textContent = "Preencha usuário e senha.";
    return;
  }

  btn.disabled  = true;
  btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Entrando...`;
  error.textContent = "";

  try {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method:      "POST",
      credentials: "include",                          // recebe o cookie do servidor
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ usuario, senha })
    });

    const data = await res.json();

    if (!res.ok) {
      error.textContent = data.error || "Usuário ou senha inválidos.";
      return;
    }

    // Armazena apenas os dados públicos do usuário — sem token
    setCurrentUser(data.user);

    // Limpa os campos da memória
    if (userEl) userEl.value = "";
    if (passEl) passEl.value = "";

    showDashboard();
    applyUserPermissions();
    refreshAll();
  } catch {
    error.textContent = "Erro de conexão. Verifique se o servidor está rodando.";
  } finally {
    btn.disabled  = false;
    btn.innerHTML = "Entrar";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  ["login-user", "login-pass"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────
async function logout() {
  try {
    await fetch(`${BASE}/api/auth/logout`, {
      method:      "POST",
      credentials: "include"   // envia o cookie para o servidor invalidar
    });
  } catch (_) {}

  setCurrentUser(null);
  location.reload();
}

// ─── Verificação de auth na inicialização ─────────────────────────────────────
// Tenta buscar o usuário atual — se o cookie for válido, o servidor responde com os dados.
// Não há token armazenado no cliente para verificar localmente.
async function checkAuth() {
  try {
    const res = await fetch(`${BASE}/api/auth/me`, {
      credentials: "include"
    });

    if (res.ok) {
      const data = await res.json();
      setCurrentUser(data.user);
      showDashboard();
      applyUserPermissions();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
}

function showDashboard() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("sidebar").style.display      = "";
  document.getElementById("dashboard").style.display    = "";
}

function showLogin() {
  setCurrentUser(null);
  document.getElementById("sidebar").style.display      = "none";
  document.getElementById("dashboard").style.display    = "none";
  document.getElementById("login-screen").style.display = "flex";
}

// ─── Sessão expirada — mostra tela de login inline sem recarregar ─────────────
let _sessionExpiredShown = false;

function showSessionExpired() {
  if (_sessionExpiredShown) return;
  _sessionExpiredShown = true;

  if (typeof showToast === "function") {
    showToast("⏱ Sua sessão expirou. Faça login novamente.", "warning");
  }

  setTimeout(() => {
    showLogin();
    _sessionExpiredShown = false;
  }, 2800);
}

// ─── Compatibilidade: getSessionToken usado em outros módulos ─────────────────
// Retorna string não-vazia se houver usuário em memória (cookie existe no navegador)
// — nunca expõe o token real
function getSessionToken() {
  return getCurrentUser() ? "cookie-session" : "";
}
