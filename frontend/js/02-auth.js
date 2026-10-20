// Modo consulta do catálogo (programa .exe da loja): a janela abre a URL com
// ?app=catalogo — só a aba Catálogo fica visível (sem menu lateral das demais
// abas). Pedido do usuário (2026-10-20): "programa exe ... esse de consulta".
const MODO_CONSULTA_CATALOGO = new URLSearchParams(location.search).get("app") === "catalogo";
if (MODO_CONSULTA_CATALOGO) document.documentElement.classList.add("modo-consulta-catalogo");

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

  // BUG CORRIGIDO: toast "A conexão demorou demais" aparecia sem motivo real
  // ao aceitar/transferir/fechar um atendimento. Causa: openConversation()
  // cancela (via _openConvAbort.abort()) a própria busca anterior toda vez
  // que é chamada de novo — e é chamada tanto pela ação em si (aceitar/
  // transferir/fechar chamam openConversation() após o sucesso) quanto pelo
  // handler do socket "ticket_atualizado"/"humanmode_atualizado" ecoando de
  // volta pro MESMO painel que disparou a ação. As duas chamadas quase
  // simultâneas fazem a 1ª busca ser abortada — um cancelamento deliberado e
  // saudável, não uma rede lenta — mas o catch abaixo tratava QUALQUER
  // AbortError como timeout de 20s e mostrava o toast de erro mesmo assim.
  // Agora só mostra o toast quando quem abortou foi o TIMER interno
  // (timeout de verdade); um abort vindo de fora (signal externo cancelando
  // uma busca obsoleta) é silencioso, como já era a intenção original.
  let timedOut = false;

  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    externalAbortHandler = () => controller.abort();
    options.signal.addEventListener("abort", externalAbortHandler, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

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
    if (err?.name === "AbortError" && timedOut) {
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
    // Restaura o contador de não lidas salvo no localStorage antes do
    // refreshAll()/badge da sidebar, senão mostraria tudo zerado por um
    // instante — ver persistUnreadMessages()/restoreUnreadMessages() em
    // 00-core.js.
    window.restoreUnreadMessages?.();

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
    // Mesmo motivo: só começa a checar o status do WhatsApp (polling) depois
    // do login — ver comentário no fim de 12-wa-recovery.js.
    window.startWaQrRecovery?.();
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
    window.restoreUnreadMessages?.();

    document.getElementById("login-2fa-form")?.classList.add("hidden");
    document.getElementById("login-form")?.classList.remove("hidden");

    showDashboard();
    applyUserPermissions();
    refreshAll();
    window.connectPanelSocket?.();
    window.startWaQrRecovery?.();
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
  // Modo consulta (programa .exe da loja): sem login. O servidor libera só a
  // leitura do catálogo pela rede interna (middlewares/catalogo-consulta.js).
  if (MODO_CONSULTA_CATALOGO) {
    setCurrentUser({
      id: 0, nome: "Consulta", usuario: "consulta", perfil: "atendente",
      permissions: { catalogo: true, dashboard: false, conversations: false, history: false, contacts: false, channels: false, metrics: false }
    });
    showDashboard();
    applyUserPermissions();
    return;
  }
  try {
    const res = await fetch(`${BASE}/api/auth/me`, {
      credentials: "include"
    });

    if (res.ok) {
      const data = await res.json();
      setCurrentUser(data.user);
      window.restoreUnreadMessages?.();
      showDashboard();
      applyUserPermissions();
      window.connectPanelSocket?.();
      window.startWaQrRecovery?.();
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
  if (MODO_CONSULTA_CATALOGO && typeof switchTab === "function") {
    switchTab("catalogo");
    if (typeof catalogoConsultaInicio === "function") catalogoConsultaInicio();
  }
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
  if (MODO_CONSULTA_CATALOGO) {
    if (typeof showToast === "function") showToast("Ação não disponível no modo consulta.", "warning");
    return;
  }
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

// ─── Efeito de paralaxe na tela de login (pedido do usuário, 2026-07-30:
// "algum jeito interessante... com um efeito") ─────────────────────────────
// Move sutilmente a foto da fachada conforme o mouse, dando sensação de
// profundidade. Só roda em telas com mouse de verdade (pointer: fine) e
// desliga sozinho se o usuário preferir menos movimento.
function initLoginParallax() {
  const visual = document.getElementById("login-visual");
  const image = visual?.querySelector(".login-visual-image");
  if (!visual || !image) return;

  const semMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const temMouse = window.matchMedia("(pointer: fine)").matches;
  if (semMovimento || !temMouse) return;

  visual.addEventListener("mousemove", (e) => {
    const rect = visual.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5;  // -0.5..0.5
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    image.style.setProperty("--login-parallax-x", `${(-px * 14).toFixed(1)}px`);
    image.style.setProperty("--login-parallax-y", `${(-py * 14).toFixed(1)}px`);
  });

  visual.addEventListener("mouseleave", () => {
    image.style.setProperty("--login-parallax-x", "0px");
    image.style.setProperty("--login-parallax-y", "0px");
  });
}

document.addEventListener("DOMContentLoaded", initLoginParallax);
