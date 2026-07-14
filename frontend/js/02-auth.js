// 02-auth.js
// Sessão gerenciada via cookie HttpOnly — o navegador envia automaticamente.
// O JS do cliente nunca vê nem armazena o token de sessão.

// ─── Usuário em memória (apenas dados públicos, sem token) ────────────────────
let _currentUser = null;

function getCurrentUser() {
  if (_currentUser) return _currentUser;
  try {
    const raw = sessionStorage.getItem("current_user");
    const sessionUser = raw ? JSON.parse(raw) : null;
    if (!sessionUser) return null;

    // Perfil salvo localmente complementa os dados públicos da sessão.
    // Mantém uma única fonte de leitura para evitar sobrescrita entre módulos.
    const key = `profile_${sessionUser.usuario || sessionUser.id}`;
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    _currentUser = saved || sessionUser;
    return _currentUser;
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
  const timeoutMs = Number(options.timeoutMs || 20000);
  const controller = new AbortController();
  let externalAbortHandler = null;

  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    externalAbortHandler = () => controller.abort();
    options.signal.addEventListener("abort", externalAbortHandler, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const { timeoutMs: _timeoutMs, signal: _signal, ...fetchOptions } = options;
    const res = await fetch(url, {
      ...fetchOptions,
      credentials: "include",              // envia o cookie HttpOnly automaticamente
      headers: apiHeaders(options.headers, options.body),
      signal: controller.signal
    });

    if (res.status === 401) {
      showSessionExpired();
      return res;
    }

    return res;
  } catch (err) {
    if (err?.name === "AbortError") {
      showToast?.("A conexão demorou demais. Tente novamente.", "warning");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (options.signal && externalAbortHandler) {
      options.signal.removeEventListener("abort", externalAbortHandler);
    }
  }
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
let _twoFactorChallengeToken = null;

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

    // Conta com 2FA ativo: não há sessão ainda — mostra o passo do código.
    if (data.requiresTwoFactor) {
      _twoFactorChallengeToken = data.challengeToken;
      showTwoFactorLoginStep();
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
    // Só conecta o socket DEPOIS do login confirmado — ver comentário em
    // 12-socket.js sobre o bug do autoConnect mostrando "sessão expirada"
    // antes mesmo do usuário logar.
    window.connectPanelSocket?.();
    // Pede permissão de notificação do navegador uma única vez pós-login
    // (nunca insiste se já foi negada) — ver 07-conversations.js.
    window.requestNotificationPermission?.();
  } catch {
    error.textContent = "Erro de conexão. Verifique se o servidor está rodando.";
  } finally {
    btn.disabled  = false;
    btn.innerHTML = "Entrar";
  }
}

// O envio do login é tratado pelo submit do formulário em 17-ui-events.js.
// Evita disparo duplo ao pressionar Enter nos campos de usuário/senha.

// ─── 2FA no login (segundo passo) ─────────────────────────────────────────────
function showTwoFactorLoginStep() {
  document.getElementById("login-form")?.classList.add("hidden");
  document.getElementById("login-2fa-form")?.classList.remove("hidden");

  const errorEl = document.getElementById("login-2fa-error");
  if (errorEl) errorEl.textContent = "";

  const codeEl = document.getElementById("login-2fa-code");
  if (codeEl) {
    codeEl.value = "";
    codeEl.focus();
  }
}

function cancelTwoFactorLogin() {
  _twoFactorChallengeToken = null;
  document.getElementById("login-2fa-form")?.classList.add("hidden");
  document.getElementById("login-form")?.classList.remove("hidden");

  const passEl = document.getElementById("login-pass");
  if (passEl) passEl.value = "";
}

async function submitTwoFactorLogin() {
  const codeEl  = document.getElementById("login-2fa-code");
  const errorEl = document.getElementById("login-2fa-error");
  const btn     = document.querySelector("#login-2fa-form button[type='submit']");

  const codigo = codeEl?.value.trim() || "";

  if (!codigo) {
    if (errorEl) errorEl.textContent = "Digite o código.";
    return;
  }

  if (!_twoFactorChallengeToken) {
    if (errorEl) errorEl.textContent = "Sessão de verificação expirou. Volte e faça login novamente.";
    return;
  }

  if (btn) {
    btn.disabled  = true;
    btn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Verificando...`;
  }
  if (errorEl) errorEl.textContent = "";

  try {
    const res = await fetch(`${BASE}/api/auth/login/verify-2fa`, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ challengeToken: _twoFactorChallengeToken, codigo })
    });

    const data = await res.json();

    if (!res.ok) {
      if (errorEl) errorEl.textContent = data.error || "Código inválido.";
      return;
    }

    _twoFactorChallengeToken = null;
    setCurrentUser(data.user);

    document.getElementById("login-2fa-form")?.classList.add("hidden");
    document.getElementById("login-form")?.classList.remove("hidden");

    showDashboard();
    applyUserPermissions();
    refreshAll();
    window.connectPanelSocket?.();
    window.requestNotificationPermission?.();
  } catch {
    if (errorEl) errorEl.textContent = "Erro de conexão. Verifique se o servidor está rodando.";
  } finally {
    if (btn) {
      btn.disabled  = false;
      btn.innerHTML = "Verificar";
    }
  }
}

// ─── Logout ───────────────────────────────────────────────────────────────────
async function logout() {
  window.disconnectPanelSocket?.();

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
      window.connectPanelSocket?.();
      window.requestNotificationPermission?.();
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
