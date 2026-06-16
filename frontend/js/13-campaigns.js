// 13-campaigns.js

let _campaignPollTimer = null;
let _campaigns = []; // cache para clonar

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
          ${campaign.image_url ? `<img src="${safe(campaign.image_url)}" class="camp-thumb-sm" alt="">` : ""}
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
            <button class="ci-btn ci-btn-start" onclick="startCampaign('${id}')" title="Iniciar">
              <i class="fa-solid fa-play"></i>
            </button>` : ""}
          ${campaign.status === "sending" ? `
            <button class="ci-btn ci-btn-cancel" onclick="cancelCampaign('${id}')" title="Cancelar">
              <i class="fa-solid fa-stop"></i>
            </button>` : ""}
          ${campaign.status === "finished" && failed > 0 ? `
            <button class="ci-btn ci-btn-retry" onclick="retryCampaign('${id}')" title="Reenviar falhas (${failed})">
              <i class="fa-solid fa-rotate"></i>
            </button>` : ""}
          <button class="ci-btn ci-btn-icon ci-btn-clone" onclick="cloneCampaign('${id}')" title="Clonar">
            <i class="fa-regular fa-copy"></i>
          </button>
          ${canDelete ? `
            <button class="ci-btn ci-btn-icon ci-btn-delete" onclick="deleteCampaign('${id}')" title="Excluir">
              <i class="fa-regular fa-trash-can"></i>
            </button>` : ""}
        </div>
      </td>
    </tr>`;
}

// ─── Carregar campanhas ───────────────────────────────────────────────────────

async function loadCampaigns() {
  if (_campaignPollTimer) {
    clearTimeout(_campaignPollTimer);
    _campaignPollTimer = null;
  }

  const list = document.getElementById("campaign-list");
  if (!list) return;

  loadCampaignStats();
  list.innerHTML = `<tr><td colspan="9" class="camp-empty"><i class="fa-solid fa-spinner fa-spin"></i> Carregando campanhas...</td></tr>`;

  try {
    const res  = await apiFetch("/api/broadcasts?limit=100");
    if (!res.ok) { list.innerHTML = `<tr><td colspan="9" class="camp-empty">Erro ao carregar campanhas.</td></tr>`; return; }
    const data = await res.json();

    _campaigns = Array.isArray(data) ? data : [];

    _renderCampaignList();

    if (_campaigns.some(c => c.status === "sending")) {
      _campaignPollTimer = setTimeout(loadCampaigns, 5000);
    }

  } catch (err) {
    console.error("Erro campanhas:", err);
    const list = document.getElementById("campaign-list");
    if (list) list.innerHTML = `<tr><td colspan="9" class="camp-empty">
      <i class="fa-solid fa-circle-exclamation"></i>
      <p>Erro ao carregar campanhas.</p>
    </td></tr>`;
  }
}

function _renderCampaignList() {
  const tbody = document.getElementById("campaign-list");
  if (!tbody) return;

  const filterSel = document.getElementById("campaign-status-filter");
  const filter    = filterSel?.value || "all";
  const filtered  = filter === "all"
    ? _campaigns
    : _campaigns.filter(c => c.status === filter);

  if (filtered.length === 0) {
    const msg = _campaigns.length === 0
      ? "Nenhuma campanha criada ainda. Clique em <strong>Nova Campanha</strong> para começar."
      : "Nenhuma campanha com este status.";
    tbody.innerHTML = `<tr><td colspan="9" class="camp-empty">
      <i class="fa-solid fa-bullhorn"></i><p>${msg}</p>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((c, i) => renderCampaignItem(c, i)).join("");
}

// ─── Filtrar campanhas ────────────────────────────────────────────────────────

function filterCampaigns() {
  _renderCampaignList();
}

// ─── Criar campanha ───────────────────────────────────────────────────────────

async function createCampaign() {
  const titleInput     = document.getElementById("campaign-title");
  const messageInput   = document.getElementById("campaign-message");
  const recipientsInput = document.getElementById("campaign-recipients");

  const title   = titleInput?.value.trim();
  const message = messageInput?.value.trim();

  const audienceType =
    document.querySelector("input[name='campaign-audience']:checked")?.value || "custom";

  if (!title || !message) {
    showToast("Preencha título e mensagem.");
    return;
  }

  let recipients = [];

  try {
    if (audienceType === "custom") {
      if (_campSelected.size === 0) { showToast("Selecione pelo menos um contato."); return; }
      recipients = [..._campSelected.values()];
    } else {
      const params = new URLSearchParams();
      if (audienceType === "contacts") {
        const { tag, atendenteId } = _getContactsFilters();
        if (tag)         params.set("tag", tag);
        if (atendenteId) params.set("atendenteId", atendenteId);
      }
      const qs = params.toString() ? `?${params}` : "";
      const audienceRes = await apiFetch(`/api/broadcasts/audience/${audienceType}${qs}`);
      if (!audienceRes?.ok) {
        const err = await audienceRes?.json().catch(() => ({}));
        showToast(err?.error || "Erro ao buscar destinatários.");
        return;
      }
      recipients = await audienceRes.json();
    }

    if (!recipients.length) { showToast("Nenhum destinatário encontrado."); return; }

    // Abre modal de confirmação antes de prosseguir
    showCampaignConfirm(recipients, message, () =>
      _doCreateCampaign(title, message, recipients)
    );

  } catch (err) {
    console.error("Erro ao criar campanha:", err);
    showToast("Erro ao criar campanha.");
  }
}

async function _doCreateCampaign(title, message, recipients) {
  const submitBtn = document.getElementById("campaign-submit-btn");

  const setLoading = on => {
    if (!submitBtn) return;
    submitBtn.disabled = on;
    submitBtn.innerHTML = on
      ? `<i class="fa-solid fa-circle-notch fa-spin"></i> Criando...`
      : `<i class="fa-solid fa-paper-plane"></i> Criar campanha`;
  };

  setLoading(true);

  try {
    let imageUrl  = null;
    let mediaType = null;
    const mediaInput = document.getElementById("campaign-media-file");

    if (_campMediaType !== "none" && mediaInput?.files?.length) {
      const formData = new FormData();
      formData.append("media", mediaInput.files[0]);

      const uploadRes  = await fetch("/api/broadcasts/upload", {
        method: "POST",
        credentials: "include",
        body: formData
      });
      const uploadData = await uploadRes.json();

      if (!uploadRes.ok) {
        showToast(uploadData.error || "Erro ao enviar arquivo.");
        return;
      }

      imageUrl  = uploadData.url;
      mediaType = uploadData.mediaType || _campMediaType;
    }

    const res  = await apiFetch("/api/broadcasts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, message, recipients, imageUrl, mediaType })
    });
    const data = await res.json();

    if (!res.ok) { showToast(data.error || "Erro ao criar campanha."); return; }

    showToast(`✅ Campanha criada com ${recipients.length} destinatário(s).`);
    closeCampaignModal();

    // Limpa formulário
    if (document.getElementById("campaign-title"))   document.getElementById("campaign-title").value   = "";
    if (document.getElementById("campaign-message")) document.getElementById("campaign-message").value = "";
    _campSelected.clear();
    _renderCampChips();
    const campSearch = document.getElementById("camp-contact-search");
    if (campSearch) campSearch.value = "";
    const campResults = document.getElementById("camp-contact-results");
    if (campResults) campResults.innerHTML = `<div class="camp-picker-hint"><i class="fa-solid fa-arrow-up"></i> Digite para buscar contatos</div>`;
    setCampaignMediaType("none", document.querySelector(".camp-media-tab"));

    updateCampaignAudienceCount();
    loadCampaignStats();

    loadCampaigns();

  } catch (err) {
    console.error("Erro ao criar campanha:", err);
    showToast("Erro ao criar campanha.");
  } finally {
    setLoading(false);
  }
}

// ─── Modal de ação genérico ───────────────────────────────────────────────────

function _showActionModal({ icon, iconClass, title, body, confirmLabel, confirmClass, onConfirm }) {
  document.getElementById("_campaign-action-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id        = "_campaign-action-overlay";
  overlay.className = "campaign-confirm-overlay";
  overlay.innerHTML = `
    <div class="campaign-confirm-modal panel">
      <div class="campaign-confirm-header">
        <i class="fa-solid ${icon} ${iconClass || ""}"></i>
        <h3>${title}</h3>
      </div>
      <p class="campaign-confirm-info">${body}</p>
      <div class="campaign-confirm-actions">
        <button class="history-clear-btn" id="_cam-cancel-btn">Cancelar</button>
        <button class="${confirmClass || "send-btn"}" id="_cam-confirm-btn">
          ${confirmLabel}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#_cam-cancel-btn").addEventListener("click",  () => overlay.remove());
  overlay.querySelector("#_cam-confirm-btn").addEventListener("click", () => {
    overlay.remove();
    onConfirm();
  });
}

// ─── Iniciar campanha ─────────────────────────────────────────────────────────

function startCampaign(id) {
  _showActionModal({
    icon: "fa-play",
    title: "Iniciar campanha",
    body: "Confirma o início do envio desta campanha para todos os destinatários?",
    confirmLabel: '<i class="fa-solid fa-play"></i> Iniciar envio',
    onConfirm: async () => {
      try {
        const res  = await apiFetch(`/api/broadcasts/${id}/start`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao iniciar campanha."); return; }
        showToast("Campanha iniciada.");
        loadCampaigns();
        loadCampaignStats();
      } catch (err) {
        console.error(err);
        showToast("Erro ao iniciar campanha.");
      }
    }
  });
}

// ─── Cancelar campanha ────────────────────────────────────────────────────────

function cancelCampaign(id) {
  _showActionModal({
    icon: "fa-stop",
    iconClass: "text-warning",
    title: "Cancelar campanha",
    body: "O envio em andamento será <strong>interrompido</strong>. Deseja continuar?",
    confirmLabel: '<i class="fa-solid fa-stop"></i> Cancelar envio',
    confirmClass: "btn-outline-danger",
    onConfirm: async () => {
      try {
        const res  = await apiFetch(`/api/broadcasts/${id}/cancel`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao cancelar."); return; }
        showToast("Campanha cancelada.");
        loadCampaigns();
        loadCampaignStats();
      } catch (err) {
        console.error(err);
        showToast("Erro ao cancelar campanha.");
      }
    }
  });
}

// ─── Reenviar falhas ──────────────────────────────────────────────────────────

function retryCampaign(id) {
  _showActionModal({
    icon: "fa-rotate",
    title: "Reenviar falhas",
    body: "Reenviar a campanha apenas para os destinatários que <strong>falharam</strong>?",
    confirmLabel: '<i class="fa-solid fa-rotate"></i> Reenviar',
    onConfirm: async () => {
      try {
        const res  = await apiFetch(`/api/broadcasts/${id}/retry`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao reenviar."); return; }
        showToast("Reenvio iniciado.");
        loadCampaigns();
        loadCampaignStats();
      } catch (err) {
        console.error(err);
        showToast("Erro ao reenviar campanha.");
      }
    }
  });
}

// ─── Deletar campanha ─────────────────────────────────────────────────────────

function deleteCampaign(id) {
  _showActionModal({
    icon: "fa-trash-can",
    iconClass: "text-danger",
    title: "Excluir campanha",
    body: "Esta ação é <strong>irreversível</strong>. A campanha e todos os dados serão excluídos permanentemente.",
    confirmLabel: '<i class="fa-regular fa-trash-can"></i> Excluir',
    confirmClass: "btn-outline-danger",
    onConfirm: async () => {
      try {
        const res  = await apiFetch(`/api/broadcasts/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao excluir."); return; }
        showToast("Campanha excluída.");
        loadCampaigns();
        loadCampaignStats();
      } catch (err) {
        console.error(err);
        showToast("Erro ao excluir campanha.");
      }
    }
  });
}

// ─── Clonar campanha ──────────────────────────────────────────────────────────

function cloneCampaign(id) {
  const c = _campaigns.find(c => String(c.id) === String(id));
  if (!c) { showToast("Campanha não encontrada."); return; }

  const titleEl   = document.getElementById("campaign-title");
  const messageEl = document.getElementById("campaign-message");
  if (titleEl)   titleEl.value   = `${c.title} (cópia)`;
  if (messageEl) messageEl.value = c.message || "";

  // Reset audiência para padrão antes de abrir
  const defaultRadio = document.querySelector("input[name='campaign-audience'][value='all_clients']");
  if (defaultRadio) defaultRadio.checked = true;

  openCampaignModal(); // já chama updateCampaignPreview() e updateMsgCounter()
  showToast("Formulário preenchido com os dados da campanha.");
}

// ─── Seletor de tipo de mídia ─────────────────────────────────────────────────

let _campMediaType = "none"; // "none" | "image" | "pdf" | "audio"

function setCampaignMediaType(type, btn) {
  _campMediaType = type;

  // Atualiza tabs
  document.querySelectorAll(".camp-media-tab").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");

  const uploadBox = document.getElementById("camp-media-upload");
  const fileInput = document.getElementById("campaign-media-file");
  const fileIcon  = document.getElementById("camp-file-icon");
  const fileName  = document.getElementById("camp-file-name");

  removeCampaignMedia(); // limpa preview anterior

  if (type === "none") {
    uploadBox?.classList.add("hidden");
    return;
  }

  uploadBox?.classList.remove("hidden");

  if (type === "image") {
    fileInput.accept = "image/*";
    if (fileIcon) fileIcon.className = "fa-solid fa-image";
    if (fileName) fileName.textContent = "Escolher imagem...";
  } else if (type === "pdf") {
    fileInput.accept = ".pdf,application/pdf";
    if (fileIcon) fileIcon.className = "fa-solid fa-file-pdf";
    if (fileName) fileName.textContent = "Escolher PDF...";
  } else if (type === "audio") {
    fileInput.accept = "audio/*,.mp3,.ogg,.m4a,.wav,.aac,.opus";
    if (fileIcon) fileIcon.className = "fa-solid fa-music";
    if (fileName) fileName.textContent = "Escolher áudio...";
  }
}

function previewCampaignMedia(event) {
  const file = event.target.files[0];
  if (!file) return;

  const fileName = document.getElementById("camp-file-name");
  if (fileName) fileName.textContent = file.name;

  // Esconde todos os previews
  ["campaign-image-preview", "campaign-pdf-preview", "campaign-audio-preview"]
    .forEach(id => document.getElementById(id)?.classList.add("hidden"));

  if (_campMediaType === "image") {
    const img = document.getElementById("campaign-preview-img");
    if (img) {
      if (img.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
      img.src = URL.createObjectURL(file);
    }
    document.getElementById("campaign-image-preview")?.classList.remove("hidden");
  } else if (_campMediaType === "pdf") {
    const nameEl = document.getElementById("campaign-pdf-name");
    if (nameEl) nameEl.textContent = file.name;
    const box = document.getElementById("campaign-pdf-preview");
    if (box) box.classList.remove("hidden");
    // display:flex overrides hidden via inline style
    if (box) box.style.display = "flex";
  } else if (_campMediaType === "audio") {
    const audio = document.getElementById("campaign-preview-audio");
    if (audio) {
      if (audio.src?.startsWith("blob:")) URL.revokeObjectURL(audio.src);
      audio.src = URL.createObjectURL(file);
    }
    document.getElementById("campaign-audio-preview")?.classList.remove("hidden");
  }

  updateCampaignPreview();
}

function removeCampaignMedia() {
  const fileInput = document.getElementById("campaign-media-file");
  const img       = document.getElementById("campaign-preview-img");
  const audio     = document.getElementById("campaign-preview-audio");

  if (img?.src?.startsWith("blob:"))   URL.revokeObjectURL(img.src);
  if (audio?.src?.startsWith("blob:")) URL.revokeObjectURL(audio.src);

  if (fileInput) fileInput.value = "";
  if (img)       img.src = "";
  if (audio)     audio.src = "";

  const pdfBox = document.getElementById("campaign-pdf-preview");
  if (pdfBox) { pdfBox.classList.add("hidden"); pdfBox.style.display = ""; }

  document.getElementById("campaign-image-preview")?.classList.add("hidden");
  document.getElementById("campaign-audio-preview")?.classList.add("hidden");

  const nameEl = document.getElementById("camp-file-name");
  if (nameEl) {
    nameEl.textContent =
      _campMediaType === "image" ? "Escolher imagem..."  :
      _campMediaType === "pdf"   ? "Escolher PDF..."     :
      _campMediaType === "audio" ? "Escolher áudio..."   : "Escolher arquivo...";
  }

  updateCampaignPreview();
}

// Mantém compatibilidade com referências antigas
function removeCampaignImage() { removeCampaignMedia(); }
function previewCampaignImage(event) { previewCampaignMedia(event); }

// ─── Destinatários customizados ───────────────────────────────────────────────

// ─── Seletor de contatos (lista personalizada) ────────────────────────────────

const _campSelected = new Map(); // whatsapp → { userId, contactName }
let _campSearchTimer = null;

function toggleCustomRecipients() {
  const selected = document.querySelector("input[name='campaign-audience']:checked")?.value;
  const customBox   = document.getElementById("custom-recipients-box");
  const filtersBox  = document.getElementById("contacts-filters-box");
  if (customBox)  customBox.classList.toggle("hidden",  selected !== "custom");
  if (filtersBox) filtersBox.classList.toggle("hidden", selected !== "contacts");
  if (selected === "contacts") loadCampaignContactsFilters();
  if (selected === "custom") {
    _campPhotoEpoch = Date.now(); // renova epoch para recarregar fotos sem cache antigo
    searchCampContacts(document.getElementById("camp-contact-search")?.value || "");
  }
  updateCampaignAudienceCount();
}

// Epoch do picker — usado como cache-bust nas fotos, renovado a cada abertura
let _campPhotoEpoch = Date.now();

async function searchCampContacts(q) {
  clearTimeout(_campSearchTimer);
  _campSearchTimer = setTimeout(async () => {
    const resultsEl = document.getElementById("camp-contact-results");
    if (!resultsEl) return;
    resultsEl.innerHTML = `<div class="camp-picker-hint"><i class="fa-solid fa-spinner fa-spin"></i> Carregando...</div>`;

    // Busca até 500 contatos — suficiente para qualquer base cadastrada
    const params = new URLSearchParams({ limit: 500, status: "ativo" });
    if (q.trim()) params.set("search", q.trim());

    try {
      const res  = await apiFetch(`/api/contacts?${params}`);
      if (!res) { resultsEl.innerHTML = `<div class="camp-picker-hint">Erro ao buscar contatos.</div>`; return; }
      const data = await res.json();
      _renderCampContactResults(data.rows || [], data.total || 0);
    } catch {
      resultsEl.innerHTML = `<div class="camp-picker-hint">Erro ao buscar contatos.</div>`;
    }
  }, 250);
}

function _renderCampContactResults(contacts, total) {
  const el = document.getElementById("camp-contact-results");
  if (!el) return;

  if (!contacts.length) {
    el.innerHTML = `<div class="camp-picker-hint">Nenhum contato encontrado.</div>`;
    _updatePickerToolbar();
    return;
  }

  el.innerHTML = contacts.map(c => {
    const phone = String(c.whatsapp || "").replace(/\D/g, "");
    if (!phone) return "";
    const sel      = _campSelected.has(phone);
    const tags     = (c.tags || []).slice(0, 2).map(t => `<span class="cp-tag">${safe(t)}</span>`).join("");
    const ini      = typeof contactInitials === "function" ? contactInitials(c.nome) : (c.nome || "?")[0].toUpperCase();
    const userId   = phone + "@s.whatsapp.net";
    // t= evita cache de foto antiga e distribui a carga evitando rate-limit
    const photoUrl = `/api/contacts/photo?userId=${encodeURIComponent(userId)}&t=${_campPhotoEpoch}`;
    return `
      <div class="cp-item ${sel ? "cp-selected" : ""}"
           data-phone="${escapeAttr(phone)}"
           data-nome="${escapeAttr(c.nome)}"
           onclick="_onCpItemClick(this)">
        <div class="cp-avatar">
          <div class="cp-avatar-ini">${ini}</div>
          <img class="cp-avatar-img" src="${photoUrl}"
            onload="this.style.display='block'"
            onerror="this.style.display='none'">
        </div>
        <div class="cp-info">
          <strong>${safe(c.nome)}</strong>
          <small>${safe(c.whatsapp)}${tags ? "&nbsp;" + tags : ""}</small>
        </div>
        <i class="fa-solid ${sel ? "fa-circle-check cp-check-on" : "fa-circle cp-check-off"}"></i>
      </div>`;
  }).join("");

  _updatePickerToolbar();
}

// Delegação de click via data attributes — evita problemas com nomes especiais em onclick inline
function _onCpItemClick(itemEl) {
  const phone = itemEl.dataset.phone;
  const nome  = itemEl.dataset.nome;
  if (!phone) return;

  if (_campSelected.has(phone)) {
    _campSelected.delete(phone);
    itemEl.classList.remove("cp-selected");
    const icon = itemEl.querySelector("i.fa-solid");
    if (icon) icon.className = "fa-solid fa-circle cp-check-off";
  } else {
    _campSelected.set(phone, { userId: phone + "@s.whatsapp.net", contactName: nome });
    itemEl.classList.add("cp-selected");
    const icon = itemEl.querySelector("i.fa-solid");
    if (icon) icon.className = "fa-solid fa-circle-check cp-check-on";
  }
  _renderCampChips();
  _updatePickerToolbar();
  updateCampaignAudienceCount();
}

function campSelectAll() {
  document.querySelectorAll(".cp-item").forEach(el => {
    const phone = el.dataset.phone;
    const nome  = el.dataset.nome;
    if (!phone) return;
    _campSelected.set(phone, { userId: phone + "@s.whatsapp.net", contactName: nome });
    el.classList.add("cp-selected");
    const icon = el.querySelector("i.fa-solid");
    if (icon) icon.className = "fa-solid fa-circle-check cp-check-on";
  });
  _renderCampChips();
  _updatePickerToolbar();
  updateCampaignAudienceCount();
}

function campClearAll() {
  _campSelected.clear();
  document.querySelectorAll(".cp-item").forEach(el => {
    el.classList.remove("cp-selected");
    const icon = el.querySelector("i.fa-solid");
    if (icon) icon.className = "fa-solid fa-circle cp-check-off";
  });
  _renderCampChips();
  _updatePickerToolbar();
  updateCampaignAudienceCount();
}

function _updatePickerToolbar() {
  const lbl = document.getElementById("camp-picker-sel-count");
  if (lbl) lbl.textContent = _campSelected.size > 0 ? `${_campSelected.size} selecionado(s)` : "";
}

function _renderCampChips() {
  const el = document.getElementById("camp-contact-chips");
  if (!el) return;
  if (_campSelected.size === 0) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  el.innerHTML = [..._campSelected.entries()].map(([phone, c]) => {
    const safePhone = phone.replace(/'/g, "\\'");
    return `<span class="camp-chip">
      ${safe(c.contactName || phone)}
      <button onclick="removeCampContact('${safePhone}')" title="Remover">&times;</button>
    </span>`;
  }).join("");
}

function removeCampContact(phone) {
  _campSelected.delete(phone);
  _renderCampChips();
  // Atualiza item na lista se ainda visível
  const item = document.querySelector(`.cp-item[data-phone="${CSS.escape(phone)}"]`);
  if (item) {
    item.classList.remove("cp-selected");
    const icon = item.querySelector("i.fa-solid");
    if (icon) icon.className = "fa-solid fa-circle cp-check-off";
  }
  _updatePickerToolbar();
  updateCampaignAudienceCount();
}

async function loadCampaignContactsFilters() {
  try {
    const [tagsRes, usersRes] = await Promise.all([
      apiFetch("/api/contacts/tags"),
      apiFetch("/api/users")
    ]);
    if (tagsRes.ok) {
      const tags = await tagsRes.json();
      const sel  = document.getElementById("camp-filter-tag");
      if (sel) {
        const cur = sel.value;
        sel.innerHTML = `<option value="">Todas as etiquetas</option>` +
          tags.map(t => `<option value="${escapeAttr(t)}" ${t === cur ? "selected" : ""}>${safe(t)}</option>`).join("");
      }
    }
    if (usersRes?.ok) {
      const users = await usersRes.json();
      const sel   = document.getElementById("camp-filter-atendente");
      if (sel) {
        const cur = sel.value;
        sel.innerHTML = `<option value="">Todos os atendentes</option>` +
          (users.rows || users).map(u =>
            `<option value="${escapeAttr(u.id)}" ${u.id === cur ? "selected" : ""}>${safe(u.nome)}</option>`
          ).join("");
      }
    }
  } catch (_) {}
}

function _getContactsFilters() {
  return {
    tag:         document.getElementById("camp-filter-tag")?.value         || "",
    atendenteId: document.getElementById("camp-filter-atendente")?.value   || ""
  };
}

async function updateCampaignAudienceCount() {
  if (!getCurrentUser()) return;
  const countBox = document.getElementById("campaign-audience-count");
  if (!countBox) return;

  const audienceType =
    document.querySelector("input[name='campaign-audience']:checked")?.value || "custom";

  if (audienceType === "custom") {
    const n = _campSelected.size;
    countBox.innerHTML = n > 0
      ? `${n} contato(s) selecionado(s).`
      : `Nenhum contato selecionado.`;
    return;
  }

  countBox.innerHTML = "Calculando destinatários...";
  try {
    const params = new URLSearchParams();
    if (audienceType === "contacts") {
      const { tag, atendenteId } = _getContactsFilters();
      if (tag)         params.set("tag", tag);
      if (atendenteId) params.set("atendenteId", atendenteId);
    }
    const qs  = params.toString() ? `?${params}` : "";
    const res  = await apiFetch(`/api/broadcasts/audience/${audienceType}${qs}`);
    if (!res.ok) { countBox.innerHTML = "Não foi possível calcular o público."; return; }
    const data = await res.json();
    countBox.innerHTML = `${data.length} destinatário(s) encontrado(s).`;
  } catch {
    countBox.innerHTML = "Erro ao calcular destinatários.";
  }
}

// ─── Estatísticas ─────────────────────────────────────────────────────────────

async function loadCampaignStats() {
  if (!getCurrentUser()) return;
  try {
    const res  = await apiFetch("/api/broadcasts/stats");
    if (!res.ok) return;
    const data = await res.json();
    const el = id => document.getElementById(id);
    if (el("campaign-stat-total"))   el("campaign-stat-total").textContent   = data.campaigns   || 0;
    if (el("campaign-stat-sent"))    el("campaign-stat-sent").textContent    = data.sent        || 0;
    if (el("campaign-stat-failed"))  el("campaign-stat-failed").textContent  = data.failed      || 0;
    if (el("campaign-stat-success")) el("campaign-stat-success").textContent = `${data.successRate || 0}%`;
  } catch (err) {
    console.error("Erro estatísticas campanhas:", err);
  }
}

// ─── Modal Nova Campanha ──────────────────────────────────────────────────────

function openCampaignModal() {
  document.getElementById("camp-modal-overlay")?.classList.remove("hidden");
  // toggleCustomRecipients já dispara searchCampContacts e updateCampaignAudienceCount internamente
  toggleCustomRecipients();
  updateCampaignPreview();
  updateMsgCounter();
}

function closeCampaignModal() {
  document.getElementById("camp-modal-overlay")?.classList.add("hidden");

  // Limpa formulário para próxima abertura
  ["campaign-title", "campaign-message"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  setCampaignMediaType("none", document.querySelector(".camp-media-tab"));

  // Reset audiência para padrão
  const defaultRadio = document.querySelector("input[name='campaign-audience'][value='all_clients']");
  if (defaultRadio) defaultRadio.checked = true;
  document.getElementById("custom-recipients-box")?.classList.add("hidden");
  document.getElementById("contacts-filters-box")?.classList.add("hidden");

  // Limpa seleção personalizada
  _campSelected.clear();
  _renderCampChips();

  updateMsgCounter();
  updateCampaignPreview();
}

function switchCampaignPanel(panel, event) {
  // no-op mantido para compatibilidade
}

// ─── Preview WhatsApp (Nova Campanha) ─────────────────────────────────────────

function updateCampaignPreview() {
  const msg     = document.getElementById("campaign-message")?.value || "";
  const textEl  = document.getElementById("camp-wa-text");
  const imgWrap = document.getElementById("camp-wa-img-wrap");
  const waImg   = document.getElementById("camp-wa-img");
  const timeEl  = document.getElementById("camp-wa-time");

  if (textEl) {
    if (msg.trim()) {
      textEl.textContent = msg;
      textEl.classList.remove("camp-wa-text-placeholder");
    } else {
      textEl.textContent = "Sua mensagem aparecerá aqui...";
      textEl.classList.add("camp-wa-text-placeholder");
    }
  }

  if (timeEl) {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  // Atualiza área de mídia do preview WhatsApp
  if (imgWrap && waImg) {
    const previewImg   = document.getElementById("campaign-preview-img");
    const mediaInput   = document.getElementById("campaign-media-file");
    const hasFile      = mediaInput?.files?.length > 0;

    if (_campMediaType === "image" && previewImg?.src && !previewImg.src.endsWith("#") && !previewImg.src.endsWith("/")) {
      waImg.src = previewImg.src;
      waImg.style.display = "";
      imgWrap.innerHTML = `<img id="camp-wa-img" src="${previewImg.src}" alt="" style="width:100%;border-radius:6px 6px 0 0;">`;
      imgWrap.classList.remove("hidden");
    } else if (_campMediaType === "pdf" && hasFile) {
      const fname = mediaInput.files[0].name;
      imgWrap.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:10px;background:rgba(255,255,255,.1);border-radius:6px 6px 0 0;">
        <i class="fa-solid fa-file-pdf" style="font-size:22px;color:#ef4444;"></i>
        <span style="font-size:12px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safe(fname)}</span>
      </div>`;
      imgWrap.classList.remove("hidden");
    } else if (_campMediaType === "audio" && hasFile) {
      imgWrap.innerHTML = `<div style="display:flex;align-items:center;gap:8px;padding:10px;background:rgba(255,255,255,.1);border-radius:6px 6px 0 0;">
        <i class="fa-solid fa-music" style="font-size:22px;color:#1d6cf5;"></i>
        <span style="font-size:12px;color:#e2e8f0;">Áudio</span>
      </div>`;
      imgWrap.classList.remove("hidden");
    } else {
      imgWrap.innerHTML = `<img id="camp-wa-img" src="" alt="">`;
      imgWrap.classList.add("hidden");
    }
  }
}

function updateMsgCounter() {
  const msg     = document.getElementById("campaign-message")?.value || "";
  const counter = document.getElementById("camp-msg-counter");
  if (counter) counter.textContent = `${msg.length} / 1024`;
}

function removeCampaignImage() {
  const input      = document.getElementById("campaign-image");
  const previewBox = document.getElementById("campaign-image-preview");
  const previewImg = document.getElementById("campaign-preview-img");
  const fileName   = document.getElementById("camp-file-name");
  if (previewImg?.src?.startsWith("blob:")) URL.revokeObjectURL(previewImg.src);
  if (input)      input.value = "";
  if (previewImg) previewImg.src = "";
  if (previewBox) previewBox.classList.add("hidden");
  if (fileName)   fileName.textContent = "Escolher imagem...";
  updateCampaignPreview();
}

// ─── Modal de confirmação ─────────────────────────────────────────────────────

function showCampaignConfirm(recipients, message, onConfirm) {
  document.getElementById("campaign-confirm-overlay")?.remove();

  // recipients pode ser array de objetos {userId,contactName} ou array de strings (custom)
  const recipientsCount = Array.isArray(recipients) ? recipients.length : recipients;
  const recipientsList  = Array.isArray(recipients) && typeof recipients[0] === "object"
    ? recipients
    : null;

  let contactsPreviewHtml = "";
  if (recipientsList && recipientsList.length > 0) {
    const SHOW_MAX = 10;
    const items    = recipientsList.slice(0, SHOW_MAX).map(r =>
      `<li><i class="fa-solid fa-user"></i> ${safe(r.contactName || r.userId || "—")}</li>`
    ).join("");
    const more = recipientsList.length > SHOW_MAX
      ? `<li class="cc-list-more">+ ${recipientsList.length - SHOW_MAX} mais...</li>`
      : "";
    contactsPreviewHtml = `
      <details class="cc-contacts-preview">
        <summary>Ver lista de destinatários (${recipientsList.length})</summary>
        <ul class="cc-contacts-list">${items}${more}</ul>
      </details>`;
  }

  const overlay = document.createElement("div");
  overlay.id        = "campaign-confirm-overlay";
  overlay.className = "campaign-confirm-overlay";
  overlay.innerHTML = `
    <div class="campaign-confirm-modal panel">
      <div class="campaign-confirm-header">
        <i class="fa-solid fa-bullhorn"></i>
        <h3>Confirmar envio</h3>
      </div>
      <p class="campaign-confirm-info">
        Você está prestes a enviar para
        <strong>${recipientsCount} destinatário(s)</strong>.
      </p>
      ${contactsPreviewHtml}
      <div class="campaign-confirm-preview">
        <span>Prévia da mensagem</span>
        <p>${safe(message.length > 300 ? message.substring(0, 300) + "…" : message)}</p>
      </div>
      <div class="campaign-confirm-actions">
        <button class="history-clear-btn" id="cc-cancel">Cancelar</button>
        <button class="send-btn" id="cc-confirm">
          <i class="fa-solid fa-paper-plane"></i> Confirmar envio
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  document.getElementById("cc-cancel").addEventListener("click",  () => overlay.remove());
  document.getElementById("cc-confirm").addEventListener("click", () => {
    overlay.remove();
    onConfirm();
  });
}
