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
      <button class="modal-close-btn" onclick="_closeModal()">&times;</button>
    </div>
    <div class="modal-body">
      <p>${safe(message)}</p>
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" onclick="_closeModal()">${safe(cancelText)}</button>
      <button class="modal-btn ${danger ? "modal-btn-danger" : "modal-btn-primary"}" id="_modal-confirm-btn">${safe(confirmText)}</button>
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
      <button class="modal-close-btn" onclick="_closeModal()">&times;</button>
    </div>
    <div class="modal-body">
      <label class="modal-label">${safe(label)}</label>
      <input id="_modal-input" type="${safe(type)}" placeholder="${safe(placeholder)}"
             class="modal-input" autocomplete="${type === "password" ? "new-password" : "off"}">
    </div>
    <div class="modal-footer">
      <button class="modal-btn modal-btn-secondary" onclick="_closeModal()">Cancelar</button>
      <button class="modal-btn modal-btn-primary" id="_modal-confirm-btn">${safe(confirmText)}</button>
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

// ─── Internos ─────────────────────────────────────────────────────────────────
function _openModal(innerHtml) {
  let overlay = document.getElementById("_global-modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "_global-modal-overlay";
    document.body.appendChild(overlay);
  }

  overlay.innerHTML = `<div class="_modal-box">${innerHtml}</div>`;
  overlay.classList.add("_modal-open");

  // Fecha ao clicar fora
  overlay.addEventListener("click", e => { if (e.target === overlay) _closeModal(); }, { once: true });

  // Fecha com Escape
  const escHandler = e => { if (e.key === "Escape") { _closeModal(); document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

function _closeModal() {
  const overlay = document.getElementById("_global-modal-overlay");
  if (overlay) overlay.classList.remove("_modal-open");
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
    }
    #_global-modal-overlay._modal-open { display: flex; }
    ._modal-box {
      background: var(--color-bg, #1e2330);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      width: min(420px, 92vw);
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(0,0,0,.5);
      animation: _modal-in .15s ease;
    }
    @keyframes _modal-in {
      from { opacity: 0; transform: scale(.96) translateY(-8px); }
      to   { opacity: 1; transform: scale(1)  translateY(0);     }
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
