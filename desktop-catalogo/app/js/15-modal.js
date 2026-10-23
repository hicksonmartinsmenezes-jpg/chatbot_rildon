// 15-modal.js
// Modais reutilizáveis que substituem confirm(), prompt() e alert() nativos.

// ─── Modal de Confirmação ─────────────────────────────────────────────────────
/**
 * Exibe um modal de confirmação estilizado.
 * @param {object} opts
 * @param {string}   opts.title        — título do modal
 * @param {string}   opts.message      — mensagem / pergunta
 * @param {string}   [opts.confirmText] — texto do botão confirmar (padrão: "Confirmar")
 * @param {string}   [opts.cancelText]  — texto do botão cancelar  (padrão: "Cancelar")
 * @param {string}   [opts.danger]      — se true, botão confirmar fica vermelho
 * @param {Function} opts.onConfirm    — callback executado ao confirmar
 */
function showConfirmModal({ title, message, confirmText = "Confirmar", cancelText = "Cancelar", danger = false, onConfirm }) {
  _openModal(`
    <div class="modal-header">
      <strong>${safe(title)}</strong>
      <button class="modal-close-btn" type="button" data-modal-close aria-label="Fechar modal">&times;</button>
    </div>
    <div class="modal-body">
      <p>${safe(message)}</p>
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" type="button" data-modal-close>${safe(cancelText)}</button>
      <button class="modal-btn ${danger ? "modal-btn-danger" : "modal-btn-primary"}" type="button" id="_modal-confirm-btn">${safe(confirmText)}</button>
    </div>
  `);

  document.getElementById("_modal-confirm-btn").addEventListener("click", () => {
    _closeModal();
    onConfirm?.();
  });
}

// ─── Modal de Entrada de Texto ────────────────────────────────────────────────
/**
 * Exibe um modal com campo de texto (substitui prompt()).
 * @param {object} opts
 * @param {string}   opts.title
 * @param {string}   opts.label
 * @param {string}   [opts.placeholder]
 * @param {string}   [opts.type]         — tipo do input ("text", "password", etc.)
 * @param {string}   [opts.confirmText]
 * @param {Function} opts.onConfirm      — recebe o valor digitado
 */
function showInputModal({ title, label, placeholder = "", type = "text", confirmText = "Confirmar", onConfirm }) {
  _openModal(`
    <div class="modal-header">
      <strong>${safe(title)}</strong>
      <button class="modal-close-btn" type="button" data-modal-close aria-label="Fechar modal">&times;</button>
    </div>
    <div class="modal-body">
      <label class="modal-label">${safe(label)}</label>
      <input id="_modal-input" type="${escapeAttr(type)}" placeholder="${escapeAttr(placeholder)}"
             class="modal-input" autocomplete="${type === "password" ? "new-password" : "off"}">
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" type="button" data-modal-close>Cancelar</button>
      <button class="modal-btn modal-btn-primary" type="button" id="_modal-confirm-btn">${safe(confirmText)}</button>
    </div>
  `);

  const input = document.getElementById("_modal-input");
  input.focus();

  const doConfirm = () => {
    const val = input.value.trim();
    if (!val) { input.classList.add("modal-input-error"); return; }
    _closeModal();
    onConfirm?.(val);
  };

  document.getElementById("_modal-confirm-btn").addEventListener("click", doConfirm);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doConfirm(); });
}

// ─── Modal de Seleção (dropdown) ─────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.title
 * @param {string}   opts.label
 * @param {{value:string,label:string}[]} opts.options
 * @param {string}   [opts.confirmText]
 * @param {Function} opts.onConfirm — recebe o value selecionado
 */
function showSelectModal({ title, label, options = [], confirmText = "Confirmar", onConfirm }) {
  const opts = options
    .map(o => `<option value="${escapeAttr(String(o.value))}">${safe(o.label)}</option>`)
    .join("");

  _openModal(`
    <div class="modal-header">
      <strong>${safe(title)}</strong>
      <button class="modal-close-btn" type="button" data-modal-close aria-label="Fechar modal">&times;</button>
    </div>
    <div class="modal-body">
      <label class="modal-label">${safe(label)}</label>
      <select id="_modal-select" class="modal-input">
        <option value="">— Selecione —</option>
        ${opts}
      </select>
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" type="button" data-modal-close>Cancelar</button>
      <button class="modal-btn modal-btn-primary" type="button" id="_modal-confirm-btn">${safe(confirmText)}</button>
    </div>
  `);

  const select = document.getElementById("_modal-select");
  select.focus();

  document.getElementById("_modal-confirm-btn").addEventListener("click", () => {
    if (!select.value) { select.classList.add("modal-input-error"); return; }
    _closeModal();
    onConfirm?.(select.value);
  });
}

// ─── Internos ─────────────────────────────────────────────────────────────────
function _openModal(innerHtml) {
  let overlay = document.getElementById("_global-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "_global-modal-overlay";
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `<div class="_modal-box" role="dialog" aria-modal="true">${innerHtml}</div>`;
  overlay.classList.remove("_modal-closing");
  overlay.classList.add("_modal-open");

  // Fecha ao clicar fora ou em botões marcados com data-modal-close, sem acumular listeners.
  if (window.__rildonModalClickHandler) {
    overlay.removeEventListener("click", window.__rildonModalClickHandler);
  }
  window.__rildonModalClickHandler = e => {
    if (e.target === overlay || e.target.closest("[data-modal-close]")) _closeModal();
  };
  overlay.addEventListener("click", window.__rildonModalClickHandler);

  // Fecha com Escape, sem acumular listeners entre aberturas
  if (window.__rildonModalEscHandler) {
    document.removeEventListener("keydown", window.__rildonModalEscHandler);
  }
  window.__rildonModalEscHandler = e => { if (e.key === "Escape") _closeModal(); };
  document.addEventListener("keydown", window.__rildonModalEscHandler);
}

function _closeModal() {
  const overlay = document.getElementById("_global-modal-overlay");
  if (overlay) {
    if (window.__rildonModalClickHandler) {
      overlay.removeEventListener("click", window.__rildonModalClickHandler);
      window.__rildonModalClickHandler = null;
    }
    // Saída animada de verdade em vez de sumir instantâneo: marca .closing
    // (roda a keyframe de saída, ver _modal-out) e só remove ._modal-open
    // (display:none) depois que a animação termina.
    overlay.classList.add("_modal-closing");
    setTimeout(() => {
      overlay.classList.remove("_modal-open");
      overlay.classList.remove("_modal-closing");
    }, 160);
  }
  if (window.__rildonModalEscHandler) {
    document.removeEventListener("keydown", window.__rildonModalEscHandler);
    window.__rildonModalEscHandler = null;
  }
}

// ─── Estilos inline do modal ─────────────────────────────────────────────────
(function injectModalStyles() {
  if (document.getElementById("_modal-styles")) return;
  const style = document.createElement("style");
  style.id = "_modal-styles";
  style.textContent = `
    #_global-modal-overlay {
      display: none;
      position: fixed; inset: 0;
      background: rgba(0,0,0,.55);
      z-index: 9999;
      align-items: center;
      justify-content: center;
      opacity: 0;
      animation: _overlay-in .16s var(--ease-out, ease) both;
    }
    #_global-modal-overlay._modal-open { display: flex; }
    #_global-modal-overlay._modal-closing {
      display: flex;
      animation: _overlay-out .16s var(--ease-in, ease) both;
    }
    @keyframes _overlay-in  { from { opacity: 0; } to { opacity: 1; } }
    @keyframes _overlay-out { from { opacity: 1; } to { opacity: 0; } }
    ._modal-box {
      background: var(--color-bg, #1e2330);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      width: min(420px, 92vw);
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
      animation: _modal-in .2s var(--ease-out, ease) both;
    }
    #_global-modal-overlay._modal-closing ._modal-box {
      animation: _modal-out .16s var(--ease-in, ease) both;
    }
    @keyframes _modal-in {
      from { opacity: 0; transform: scale(.96) translateY(-8px); }
      to   { opacity: 1; transform: scale(1)  translateY(0);     }
    }
    @keyframes _modal-out {
      from { opacity: 1; transform: scale(1)   translateY(0);    }
      to   { opacity: 0; transform: scale(.97) translateY(-6px); }
    }
    .modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px 12px;
      border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .modal-header strong { font-size: 15px; color: var(--color-text, #e2e8f0); }
    .modal-close-btn {
      background: none; border: none; cursor: pointer;
      font-size: 20px; line-height: 1;
      color: var(--color-text-muted, #94a3b8);
      padding: 0 4px;
    }
    .modal-close-btn:hover { color: var(--color-text, #e2e8f0); }
    .modal-body  { padding: 16px 20px; }
    .modal-body p { margin: 0; font-size: 14px; color: var(--color-text-muted, #94a3b8); line-height: 1.5; }
    .modal-label { display: block; font-size: 13px; color: var(--color-text-muted, #94a3b8); margin-bottom: 8px; }
    .modal-input {
      width: 100%; box-sizing: border-box;
      padding: 9px 12px; font-size: 14px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.15);
      border-radius: 8px;
      color: var(--color-text, #e2e8f0);
      outline: none; transition: border-color .15s;
    }
    .modal-input:focus { border-color: var(--primary, #1d6cf5); }
    .modal-input.modal-input-error { border-color: #e53e3e; animation: _shake .2s; }
    select.modal-input {
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%2394a3b8' stroke-width='1.8' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 12px center;
      padding-right: 36px;
      cursor: pointer;
    }
    select.modal-input option {
      background: var(--color-sidebar, #1a1f2e);
      color: var(--color-text, #e2e8f0);
      padding: 8px 12px;
    }
    @keyframes _shake {
      0%,100%{ transform: translateX(0); }
      25%    { transform: translateX(-4px); }
      75%    { transform: translateX(4px); }
    }
    .modal-footer {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 20px 16px;
      border-top: 1px solid rgba(255,255,255,.08);
    }
    .modal-btn {
      padding: 8px 18px; font-size: 13px; font-weight: 500;
      border-radius: 8px; cursor: pointer; border: none; transition: opacity .15s;
    }
    .modal-btn:hover { opacity: .85; }
    .modal-btn-secondary {
      background: rgba(255,255,255,.08);
      color: var(--color-text-muted, #94a3b8);
    }
    .modal-btn-primary { background: var(--primary, #1d6cf5); color: #fff; }
    .modal-btn-danger  { background: #e53e3e; color: #fff; }
  `;
  document.head.appendChild(style);
})();
