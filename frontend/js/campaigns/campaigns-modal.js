// campaigns-modal.js
// Modal reutilizável de ações de campanha.

function showCampaignActionModal({ icon, iconClass, title, body, confirmLabel, confirmClass, onConfirm }) {
  document.getElementById("_campaign-action-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "_campaign-action-overlay";
  overlay.className = "campaign-confirm-overlay";
  overlay.innerHTML = `
    <div class="campaign-confirm-modal panel">
      <div class="campaign-confirm-header">
        <i class="fa-solid ${escapeAttr(icon)} ${escapeAttr(iconClass || "")}"></i>
        <h3>${safe(title)}</h3>
      </div>
      <p class="campaign-confirm-info">${body}</p>
      <div class="campaign-confirm-actions">
        <button type="button" class="history-clear-btn" id="_cam-cancel-btn">Cancelar</button>
        <button type="button" class="${escapeAttr(confirmClass || "send-btn")}" id="_cam-confirm-btn">
          ${confirmLabel}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#_cam-cancel-btn")?.addEventListener("click", () => overlay.remove());
  overlay.querySelector("#_cam-confirm-btn")?.addEventListener("click", () => {
    overlay.remove();
    onConfirm?.();
  });
}
