// campaigns-render.js
// Helpers e renderização da lista de campanhas.

const STATUS_LABEL = {
  pending:   "Aguardando",
  sending:   "Enviando",
  finished:  "Finalizado",
  cancelled: "Cancelado"
};

const STATUS_CLASS = {
  pending:   "cs-pending",
  sending:   "cs-sending",
  finished:  "cs-finished",
  cancelled: "cs-cancelled"
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
    + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// ─── Renderização (tabela) ────────────────────────────────────────────────────

function renderCampaignItem(campaign, index) {
  const id        = escapeAttr(String(campaign.id));
  const total     = Number(campaign.total_recipients || 0);
  const sent      = Number(campaign.sent_count || 0);
  const failed    = Number(campaign.failed_count || 0);
  const processed = sent + failed;
  const progress  = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const allFailed = total > 0 && failed === total && processed > 0;
  const label     = STATUS_LABEL[campaign.status] || campaign.status;
  const cls       = STATUS_CLASS[campaign.status] || "";
  const preview   = (campaign.message || "").slice(0, 60) + (campaign.message?.length > 60 ? "…" : "");

  const barColor  = allFailed ? "#ef4444"
    : campaign.status === "cancelled" ? "#475569"
    : "var(--primary)";
  const canDelete = campaign.status !== "sending";

  let etaText = "";
  if (campaign.status === "sending" && total > processed) {
    const mins = Math.ceil((total - processed) * 5 / 60);
    etaText = ` (~${mins}min)`;
  }

  return `
    <tr id="ci-${id}" class="camp-tr">
      <td class="camp-td-num">${index + 1}</td>
      <td class="camp-td-title">
        <div class="camp-title-cell">
          ${campaign.image_url ? `<img src="${escapeAttr(safeUrl(campaign.image_url))}" class="camp-thumb-sm" alt="">` : ""}
          <div>
            <strong>${safe(campaign.title)}</strong>
            <small>${safe(preview)}</small>
          </div>
        </div>
      </td>
      <td class="camp-td-date">${_fmtDate(campaign.created_at)}</td>
      <td><span class="campaign-status-badge ${cls}">${safe(label)}</span></td>
      <td class="camp-td-num">${total}</td>
      <td class="camp-td-num camp-td-sent">${sent}</td>
      <td class="camp-td-num ${failed > 0 ? "camp-td-failed" : ""}">${failed}</td>
      <td class="camp-td-progress">
        <div class="camp-prog-wrap">
          <div class="camp-prog-bar"><div style="width:${progress}%;background:${barColor}"></div></div>
          <span>${progress}%${etaText}</span>
        </div>
      </td>
      <td class="camp-td-actions">
        <div class="camp-td-actions-inner">
          ${campaign.status === "pending" ? `
            <button type="button" class="ci-btn ci-btn-start" data-campaign-action="start" data-campaign-id="${id}" title="Iniciar">
              <i class="fa-solid fa-play"></i>
            </button>` : ""}
          ${campaign.status === "sending" ? `
            <button type="button" class="ci-btn ci-btn-cancel" data-campaign-action="cancel" data-campaign-id="${id}" title="Cancelar">
              <i class="fa-solid fa-stop"></i>
            </button>` : ""}
          ${campaign.status === "finished" && failed > 0 ? `
            <button type="button" class="ci-btn ci-btn-retry" data-campaign-action="retry" data-campaign-id="${id}" title="Reenviar falhas (${failed})">
              <i class="fa-solid fa-rotate"></i>
            </button>` : ""}
          <button type="button" class="ci-btn ci-btn-icon ci-btn-clone" data-campaign-action="clone" data-campaign-id="${id}" title="Clonar">
            <i class="fa-regular fa-copy"></i>
          </button>
          ${canDelete ? `
            <button type="button" class="ci-btn ci-btn-icon ci-btn-delete" data-campaign-action="delete" data-campaign-id="${id}" title="Excluir">
              <i class="fa-regular fa-trash-can"></i>
            </button>` : ""}
        </div>
      </td>
    </tr>`;
}

function bindCampaignActionDelegation() {
  const list = document.getElementById("campaign-list");
  if (!list || list.dataset.delegated === "true") return;
  list.dataset.delegated = "true";

  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-campaign-action]");
    if (!btn || !list.contains(btn)) return;

    const id = btn.dataset.campaignId;
    if (!id) return;

    switch (btn.dataset.campaignAction) {
      case "start": return startCampaign(id);
      case "cancel": return cancelCampaign(id);
      case "retry": return retryCampaign(id);
      case "clone": return cloneCampaign(id);
      case "delete": return deleteCampaign(id);
    }
  });
}
