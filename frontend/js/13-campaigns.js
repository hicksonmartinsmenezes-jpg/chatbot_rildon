// 13-campaigns.js

let _campaignPollTimer = null;
let _campaigns = []; // cache para clonar

// Helpers e renderização extraídos para js/campaigns/campaigns-render.js

// ─── Carregar campanhas ───────────────────────────────────────────────────────

async function loadCampaigns() {
  return runExclusive("loadCampaigns", _loadCampaignsCore);
}

async function _loadCampaignsCore() {
  if (_campaignPollTimer) {
    clearTimeout(_campaignPollTimer);
    _campaignPollTimer = null;
  }

  const list = document.getElementById("campaign-list");
  if (!list) return;
  bindCampaignActionDelegation();

  loadCampaignStats();
  loadCampaignSchedules();
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

  const maxVisible = 250;
  const visible = filtered.slice(0, maxVisible);
  const hiddenCount = Math.max(0, filtered.length - visible.length);
  tbody.innerHTML = visible.map((c, i) => renderCampaignItem(c, i)).join("") +
    (hiddenCount > 0 ? `<tr><td colspan="9" class="camp-empty camp-list-limit">
      <i class="fa-solid fa-gauge-high"></i>
      <p>Mostrando ${maxVisible} de ${filtered.length} campanhas. Use o filtro de status para refinar a listagem.</p>
    </td></tr>` : "");
}

// ─── Filtrar campanhas ────────────────────────────────────────────────────────

function filterCampaigns() {
  _renderCampaignList();
}

// ─── Criar campanha ───────────────────────────────────────────────────────────

async function createCampaign() {
  const sendMode =
    document.querySelector("input[name='campaign-send-mode']:checked")?.value || "now";

  // Pedido do usuário (2026-08-05): "repetir campanha ou agendar" — opção de
  // agendar pra data/hora futura (única ou recorrente) segue um fluxo
  // separado (_createCampaignSchedule), já que não resolve/envia destinatários
  // agora, só guarda o filtro pra reavaliar no momento do disparo.
  if (sendMode === "schedule") return _createCampaignSchedule();

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
        const { tags, atendenteId } = _getContactsFilters();
        tags.forEach(t => params.append("tags", t));
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
    const { imageUrl, mediaType } = await _resolveCampaignMedia();

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
    showToast(err.message || "Erro ao criar campanha.");
  } finally {
    setLoading(false);
  }
}

// Upload de mídia nova (se um arquivo foi escolhido) ou reaproveitamento da
// mídia de uma campanha original (ver repeatCampaign) — usado tanto no envio
// imediato quanto no agendamento, pra não duplicar a lógica de upload.
async function _resolveCampaignMedia() {
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
      throw new Error(uploadData.error || "Erro ao enviar arquivo.");
    }

    return { imageUrl: uploadData.url, mediaType: uploadData.mediaType || _campMediaType };
  }

  if (_campMediaType !== "none" && _campReuseMediaUrl) {
    return { imageUrl: _campReuseMediaUrl, mediaType: _campReuseMediaType };
  }

  return { imageUrl: null, mediaType: null };
}

// ─── Agendar campanha (única futura ou recorrente) ────────────────────────────

async function _createCampaignSchedule() {
  const titleInput       = document.getElementById("campaign-title");
  const messageInput     = document.getElementById("campaign-message");
  const scheduledAtInput = document.getElementById("campaign-schedule-at");
  const recurrenceInput  = document.getElementById("campaign-schedule-recurrence");

  const title     = titleInput?.value.trim();
  const message   = messageInput?.value.trim();
  const scheduledAtLocal = scheduledAtInput?.value || "";
  const recurrence = recurrenceInput?.value || "";

  const audienceType =
    document.querySelector("input[name='campaign-audience']:checked")?.value || "custom";

  if (!title || !message) { showToast("Preencha título e mensagem."); return; }
  if (!scheduledAtLocal) { showToast("Escolha a data e hora do agendamento."); return; }

  const scheduledDate = new Date(scheduledAtLocal);
  if (Number.isNaN(scheduledDate.getTime())) { showToast("Data/hora de agendamento inválida."); return; }
  if (scheduledDate.getTime() <= Date.now()) { showToast("Escolha uma data/hora no futuro."); return; }

  let audienceTags = [];
  let audienceAtendenteId = "";
  let customRecipients = null;

  if (audienceType === "custom") {
    if (_campSelected.size === 0) { showToast("Selecione pelo menos um contato."); return; }
    customRecipients = [..._campSelected.values()];
  } else if (audienceType === "contacts") {
    const filters = _getContactsFilters();
    audienceTags = filters.tags;
    audienceAtendenteId = filters.atendenteId;
  }

  // Checagem rápida: alerta se o público já está vazio HOJE (a audiência real
  // é recalculada de novo no momento do disparo, então isso é só um aviso
  // preventivo, não trava o agendamento se a checagem falhar por outro motivo).
  if (audienceType !== "custom") {
    try {
      const params = new URLSearchParams();
      audienceTags.forEach(t => params.append("tags", t));
      if (audienceAtendenteId) params.set("atendenteId", audienceAtendenteId);
      const qs = params.toString() ? `?${params}` : "";
      const audienceRes = await apiFetch(`/api/broadcasts/audience/${audienceType}${qs}`);
      if (audienceRes?.ok) {
        const preview = await audienceRes.json();
        if (!preview.length) {
          showToast("Nenhum destinatário encontrado para esse público agora — ajuste o filtro antes de agendar.");
          return;
        }
      }
    } catch (_) { /* não bloqueia o agendamento se a pré-checagem falhar */ }
  }

  const submitBtn = document.getElementById("campaign-submit-btn");
  const setLoading = on => {
    if (!submitBtn) return;
    submitBtn.disabled = on;
    submitBtn.innerHTML = on
      ? `<i class="fa-solid fa-circle-notch fa-spin"></i> Agendando...`
      : `<i class="fa-solid fa-clock"></i> Agendar campanha`;
  };
  setLoading(true);

  try {
    const { imageUrl, mediaType } = await _resolveCampaignMedia();

    const res = await apiFetch("/api/campaign-schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title, message, imageUrl, mediaType,
        audienceType, audienceTags, audienceAtendenteId, customRecipients,
        scheduledAt: scheduledDate.toISOString(),
        recurrence: recurrence || null
      })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "Erro ao agendar campanha."); return; }

    showToast(recurrence ? "Campanha recorrente agendada." : "Campanha agendada.");
    closeCampaignModal();
    loadCampaignSchedules();

  } catch (err) {
    console.error("Erro ao agendar campanha:", err);
    showToast(err.message || "Erro ao agendar campanha.");
  } finally {
    setLoading(false);
  }
}

// ─── Modal de ação genérico ───────────────────────────────────────────────────

function _showActionModal(options) {
  return showCampaignActionModal(options);
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

// ─── Repetir campanha (reenvio editável) ──────────────────────────────────────

// Pedido do usuário (2026-08-05): "Repetir campanha" = reabrir o modal Nova
// Campanha pré-preenchido com título, mensagem e mídia da campanha já
// enviada, com chance de editar antes de reenviar — não é um reenvio
// silencioso/exato. Substitui o antigo "Clonar" (mesma ideia, agora também
// reaproveita a mídia em vez de só título+mensagem).
function repeatCampaign(id) {
  const c = _campaigns.find(c => String(c.id) === String(id));
  if (!c) { showToast("Campanha não encontrada."); return; }

  const titleEl   = document.getElementById("campaign-title");
  const messageEl = document.getElementById("campaign-message");
  if (titleEl)   titleEl.value   = c.title || "";
  if (messageEl) messageEl.value = c.message || "";

  // Reset audiência e modo de envio para padrão antes de abrir — o usuário
  // escolhe de novo (a lista de destinatários pode ter mudado desde então).
  const defaultRadio = document.querySelector("input[name='campaign-audience'][value='all_clients']");
  if (defaultRadio) defaultRadio.checked = true;
  const nowRadio = document.querySelector("input[name='campaign-send-mode'][value='now']");
  if (nowRadio) nowRadio.checked = true;

  openCampaignModal(); // já chama updateCampaignPreview(), updateMsgCounter() e reseta mídia

  if (c.image_url) {
    const type = c.media_type === "pdf" ? "pdf" : c.media_type === "audio" ? "audio" : "image";
    const tabBtn = document.querySelector(`.camp-media-tab[data-value="${type}"]`);
    setCampaignMediaType(type, tabBtn);
    _campReuseMediaUrl  = c.image_url;
    _campReuseMediaType = c.media_type || type;
    _showReusedMediaPreview(c.image_url, _campReuseMediaType);
  }

  updateMsgCounter();
  updateCampaignPreview();
  showToast("Formulário preenchido com os dados da campanha — revise e envie (ou agende).");
}

// Mostra a mídia de uma campanha original no preview, sem exigir reupload —
// só quando o usuário anexa um arquivo novo (previewCampaignMedia) ou remove
// a mídia (removeCampaignMedia) é que a reutilização é descartada.
function _showReusedMediaPreview(url, type) {
  if (type === "image") {
    const img = document.getElementById("campaign-preview-img");
    if (img) img.src = url;
    document.getElementById("campaign-image-preview")?.classList.remove("hidden");
    const fileName = document.getElementById("camp-file-name");
    if (fileName) fileName.textContent = "(mídia da campanha original — anexe outra pra trocar)";
  } else if (type === "pdf") {
    const nameEl = document.getElementById("campaign-pdf-name");
    if (nameEl) nameEl.textContent = "(PDF da campanha original)";
    const box = document.getElementById("campaign-pdf-preview");
    if (box) { box.classList.remove("hidden"); box.style.display = "flex"; }
  } else if (type === "audio") {
    const audio = document.getElementById("campaign-preview-audio");
    if (audio) audio.src = url;
    document.getElementById("campaign-audio-preview")?.classList.remove("hidden");
  }
  updateCampaignPreview();
}

// ─── Seletor de tipo de mídia ─────────────────────────────────────────────────

let _campMediaType = "none"; // "none" | "image" | "pdf" | "audio"

// Mídia reaproveitada de uma campanha original ao "Repetir" (ver
// repeatCampaign) — evita reupload quando o usuário não anexa um arquivo
// novo. Zerado assim que um arquivo novo é escolhido ou a mídia é removida.
let _campReuseMediaUrl  = null;
let _campReuseMediaType = null;

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

  // Usuário escolheu um arquivo novo — descarta a mídia reaproveitada de uma
  // campanha original (ver repeatCampaign/_campReuseMediaUrl).
  _campReuseMediaUrl  = null;
  _campReuseMediaType = null;

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
  _campReuseMediaUrl  = null;
  _campReuseMediaType = null;

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
    const bust = window.__avatarCacheBust || (window.__avatarCacheBust = Date.now());
    const photoUrl = `/api/contacts/photo?userId=${encodeURIComponent(userId)}&v=${bust}&t=${_campPhotoEpoch}`;
    return `
      <div class="cp-item ${sel ? "cp-selected" : ""}"
           data-phone="${escapeAttr(phone)}"
           data-nome="${escapeAttr(c.nome)}">
        <div class="cp-avatar">
          <div class="cp-avatar-ini">${ini}</div>
          <img class="cp-avatar-img" src="${escapeAttr(safeUrl(photoUrl))}" data-avatar-img="true" data-avatar-user="${escapeAttr(userId)}" style="display:none;">
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
function bindCampaignPickerDelegation() {
  const overlay = document.getElementById("camp-modal-overlay");
  if (!overlay || overlay.dataset.pickerDelegated === "true") return;
  overlay.dataset.pickerDelegated = "true";

  overlay.addEventListener("click", (event) => {
    const item = event.target.closest(".cp-item");
    if (item && overlay.contains(item)) {
      _onCpItemClick(item);
      return;
    }

    const removeBtn = event.target.closest("[data-camp-chip-remove]");
    if (removeBtn && overlay.contains(removeBtn)) {
      removeCampContact(removeBtn.dataset.campChipRemove || "");
    }
  });
}

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
  el.innerHTML = [..._campSelected.entries()].map(([phone, c]) => `
    <span class="camp-chip">
      ${safe(c.contactName || phone)}
      <button type="button" data-camp-chip-remove="${escapeAttr(phone)}" title="Remover">&times;</button>
    </span>`).join("");
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
    const usersRes = await apiFetch("/api/users");
    if (usersRes?.ok) {
      const allUsers = await usersRes.json();
      const sel   = document.getElementById("camp-filter-atendente");
      if (sel) {
        // Pedido do usuário (2026-08-03): não usar mais um bloco separado de
        // botões "Contatos por vendedor" — os 10 vendedores (Rafael, Dudu
        // etc.) entram como opções DENTRO do próprio select "Todos os
        // atendentes", junto com os atendentes reais do painel. Como esses
        // 10 nomes não são necessariamente contas de usuário (são só listas
        // de contato exportadas do celular), cada opção de vendedor usa um
        // value prefixado "tag:" pra sinalizar que o filtro deve ser por
        // ETIQUETA ("Contatos <Nome>"), não por atendente_id — ver
        // _getContactsFilters() logo abaixo, que faz essa distinção.
        // Administrador/supervisor continuam de fora (não atendem cliente
        // diretamente).
        const vendedores = (allUsers.rows || allUsers)
          .filter(u => u.perfil !== "admin" && u.perfil !== "supervisor");
        const cur = sel.value;
        const opcoesVendedoresLista = VENDOR_TAGS.map(tag => {
          const label = tag.replace(/^Contatos\s+/i, "");
          const value = `tag:${tag}`;
          return `<option value="${escapeAttr(value)}" ${value === cur ? "selected" : ""}>${safe(label)}</option>`;
        }).join("");
        const opcoesAtendentesPainel = vendedores.map(u =>
          `<option value="${escapeAttr(u.id)}" ${u.id === cur ? "selected" : ""}>${safe(u.nome)}</option>`
        ).join("");
        sel.innerHTML = `<option value="">Todos os atendentes</option>` +
          `<optgroup label="Vendedores (lista de contatos)">${opcoesVendedoresLista}</optgroup>` +
          `<optgroup label="Atendentes do painel">${opcoesAtendentesPainel}</optgroup>`;
      }
    }
  } catch (_) {}
}

// As mesmas 10 etiquetas "Contatos <Nome>" criadas via
// scripts/bulk-tag-contacts.js — usadas pra popular o select de atendente
// (ver loadCampaignContactsFilters) e reconhecidas em _getContactsFilters.
const VENDOR_TAGS = [
  "Contatos Rafael",
  "Contatos Dudu",
  "Contatos Luana",
  "Contatos Anthony",
  "Contatos Nete",
  "Contatos Halison",
  "Contatos Gislei",
  "Contatos Gustavo",
  "Contatos Claudiston",
  "Contatos Carol Recepcionista"
];

// Select "Todos os atendentes" é a única forma de filtrar em Contatos agora
// (pedido do usuário, 2026-08-03: removido o checklist de etiquetas visível
// — ficava poluído com "Clientes", "Diretor Geral" etc. misturado aos 10
// vendedores). Se o value começar com "tag:", é um dos 10 vendedores
// (filtra por etiqueta "Contatos <Nome>"); senão é um atendente_id de
// verdade (usuário real do painel).
function _getContactsFilters() {
  const atendenteSelValue = document.getElementById("camp-filter-atendente")?.value || "";
  let atendenteId = "";
  let tags = [];
  if (atendenteSelValue.startsWith("tag:")) {
    tags = [atendenteSelValue.slice(4)];
  } else {
    atendenteId = atendenteSelValue;
  }
  return { tags, atendenteId };
}

// Alterna o destaque visual (.active) do pill ao (des)marcar o checkbox —
// genérico, usado hoje só pelo checklist de tags manuais do modal Editar
// Contato (#contact-tags-checklist em index.html; ver 16-contacts.js).
// Campanhas não usa mais pills de etiqueta (removido em 2026-08-03), mas o
// listener continua aqui por já existir globalmente no bundle.
document.addEventListener("change", (event) => {
  const checkbox = event.target.closest(".camp-tag-pill input[type=checkbox]");
  if (!checkbox) return;
  checkbox.closest(".camp-tag-pill").classList.toggle("active", checkbox.checked);
});

async function updateCampaignAudienceCount() {
  if (!getCurrentUser()) return;
  const countBox   = document.getElementById("campaign-audience-count");
  const previewBox = document.getElementById("camp-contacts-preview");
  if (!countBox) return;

  const audienceType =
    document.querySelector("input[name='campaign-audience']:checked")?.value || "custom";

  if (audienceType === "custom") {
    const n = _campSelected.size;
    countBox.innerHTML = n > 0
      ? `${n} contato(s) selecionado(s).`
      : `Nenhum contato selecionado.`;
    if (previewBox) previewBox.innerHTML = "";
    return;
  }

  countBox.innerHTML = "Calculando destinatários...";
  if (previewBox) previewBox.innerHTML = "";
  try {
    const params = new URLSearchParams();
    if (audienceType === "contacts") {
      const { tags, atendenteId } = _getContactsFilters();
      tags.forEach(t => params.append("tags", t));
      if (atendenteId) params.set("atendenteId", atendenteId);
    }
    const qs  = params.toString() ? `?${params}` : "";
    const res  = await apiFetch(`/api/broadcasts/audience/${audienceType}${qs}`);
    if (!res.ok) { countBox.innerHTML = "Não foi possível calcular o público."; return; }
    const data = await res.json();
    countBox.innerHTML = `${data.length} destinatário(s) encontrado(s).`;

    // Pedido do usuário: mostrar a lista de contatos referentes ao filtro
    // escolhido, não só a contagem — substitui o checklist de etiquetas que
    // ficava nesse mesmo espaço.
    if (previewBox) {
      if (!data.length) {
        previewBox.innerHTML = `<div class="camp-contacts-preview-empty">Nenhum contato encontrado pra esse filtro.</div>`;
      } else {
        previewBox.innerHTML = data.map(item => `
          <div class="camp-contacts-preview-item">
            <span class="ccp-nome">${safe(item.contactName || "(sem nome)")}</span>
            <span class="ccp-fone">${safe(formatContactPhone(item.userId))}</span>
          </div>`).join("");
      }
    }
  } catch {
    countBox.innerHTML = "Erro ao calcular destinatários.";
  }
}

// ─── Campanhas agendadas (única futura ou recorrente) ─────────────────────────

let _campaignSchedules = [];

async function loadCampaignSchedules() {
  const tbody = document.getElementById("campaign-schedule-list");
  if (!tbody) return;
  bindCampaignScheduleActionDelegation();

  try {
    const res = await apiFetch("/api/campaign-schedules");
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5" class="camp-empty">Erro ao carregar agendamentos.</td></tr>`; return; }
    _campaignSchedules = await res.json();
    _renderCampaignScheduleList();
  } catch (err) {
    console.error("Erro agendamentos:", err);
    tbody.innerHTML = `<tr><td colspan="5" class="camp-empty">Erro ao carregar agendamentos.</td></tr>`;
  }
}

function _renderCampaignScheduleList() {
  const tbody = document.getElementById("campaign-schedule-list");
  if (!tbody) return;

  if (!_campaignSchedules.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="camp-empty">
      <i class="fa-solid fa-clock"></i><p>Nenhuma campanha agendada.</p>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = _campaignSchedules.map(s => renderCampaignScheduleItem(s)).join("");
}

function pauseCampaignSchedule(id) {
  _showActionModal({
    icon: "fa-pause",
    title: "Pausar agendamento",
    body: "Os disparos futuros dessa campanha ficam pausados até você retomar. Continuar?",
    confirmLabel: '<i class="fa-solid fa-pause"></i> Pausar',
    onConfirm: async () => {
      try {
        const res = await apiFetch(`/api/campaign-schedules/${id}/pause`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao pausar."); return; }
        showToast("Agendamento pausado.");
        loadCampaignSchedules();
      } catch (err) {
        console.error(err);
        showToast("Erro ao pausar agendamento.");
      }
    }
  });
}

function resumeCampaignSchedule(id) {
  _showActionModal({
    icon: "fa-play",
    title: "Retomar agendamento",
    body: "Retomar os disparos automáticos dessa campanha?",
    confirmLabel: '<i class="fa-solid fa-play"></i> Retomar',
    onConfirm: async () => {
      try {
        const res = await apiFetch(`/api/campaign-schedules/${id}/resume`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao retomar."); return; }
        showToast("Agendamento retomado.");
        loadCampaignSchedules();
      } catch (err) {
        console.error(err);
        showToast("Erro ao retomar agendamento.");
      }
    }
  });
}

function cancelCampaignSchedule(id) {
  _showActionModal({
    icon: "fa-ban",
    iconClass: "text-warning",
    title: "Cancelar agendamento",
    body: "Essa campanha agendada não será mais disparada. Deseja continuar?",
    confirmLabel: '<i class="fa-solid fa-ban"></i> Cancelar agendamento',
    confirmClass: "btn-outline-danger",
    onConfirm: async () => {
      try {
        const res = await apiFetch(`/api/campaign-schedules/${id}/cancel`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao cancelar."); return; }
        showToast("Agendamento cancelado.");
        loadCampaignSchedules();
      } catch (err) {
        console.error(err);
        showToast("Erro ao cancelar agendamento.");
      }
    }
  });
}

function deleteCampaignSchedule(id) {
  _showActionModal({
    icon: "fa-trash-can",
    iconClass: "text-danger",
    title: "Excluir agendamento",
    body: "Esta ação é <strong>irreversível</strong>.",
    confirmLabel: '<i class="fa-regular fa-trash-can"></i> Excluir',
    confirmClass: "btn-outline-danger",
    onConfirm: async () => {
      try {
        const res = await apiFetch(`/api/campaign-schedules/${id}`, { method: "DELETE" });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || "Erro ao excluir."); return; }
        showToast("Agendamento excluído.");
        loadCampaignSchedules();
      } catch (err) {
        console.error(err);
        showToast("Erro ao excluir agendamento.");
      }
    }
  });
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
  bindCampaignPickerDelegation();
  document.getElementById("camp-modal-overlay")?.classList.remove("hidden");
  // toggleCustomRecipients já dispara searchCampContacts e updateCampaignAudienceCount internamente
  toggleCustomRecipients();
  toggleCampaignSendMode();
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

  // Reset agendamento (Enviar agora / Agendar) — cada abertura começa do zero
  const nowRadio = document.querySelector("input[name='campaign-send-mode'][value='now']");
  if (nowRadio) nowRadio.checked = true;
  const scheduledAtInput = document.getElementById("campaign-schedule-at");
  if (scheduledAtInput) scheduledAtInput.value = "";
  const recurrenceInput = document.getElementById("campaign-schedule-recurrence");
  if (recurrenceInput) recurrenceInput.value = "";
  toggleCampaignSendMode();

  // Limpa seleção personalizada
  _campSelected.clear();
  _renderCampChips();

  _campReuseMediaUrl  = null;
  _campReuseMediaType = null;

  updateMsgCounter();
  updateCampaignPreview();
}

// Alterna entre "Enviar agora" e "Agendar" — mostra/esconde os campos de
// data/recorrência e atualiza o texto do botão de submit do modal.
function toggleCampaignSendMode() {
  const mode = document.querySelector("input[name='campaign-send-mode']:checked")?.value || "now";
  const box = document.getElementById("campaign-schedule-box");
  if (box) box.classList.toggle("hidden", mode !== "schedule");

  const submitBtn = document.getElementById("campaign-submit-btn");
  if (submitBtn) {
    submitBtn.innerHTML = mode === "schedule"
      ? `<i class="fa-solid fa-clock"></i> Agendar campanha`
      : `<i class="fa-solid fa-paper-plane"></i> Criar campanha`;
  }
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
      const previewSrc = safeUrl(previewImg.src);
      waImg.src = previewSrc;
      waImg.style.display = "";
      imgWrap.innerHTML = `<img id="camp-wa-img" src="${escapeAttr(previewSrc)}" alt="" style="width:100%;border-radius:6px 6px 0 0;">`;
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

// Compatibilidade: usa o fluxo único de mídia de campanha.
// Evita divergência com o campo antigo campaign-image.

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
        <button type="button" class="history-clear-btn" id="cc-cancel">Cancelar</button>
        <button type="button" class="send-btn" id="cc-confirm">
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

// ─── Detalhes da campanha ──────────────────────────────────────────────────────

// Pedido do usuário (2026-08-05): poder ver os detalhes de uma campanha —
// mensagem completa, mídia, e a lista de destinatários com status individual
// (enviado/falhou/aguardando), não só os números agregados da tabela.
// Reaproveita GET /api/broadcasts/:id/recipients, que já existia (usado só
// internamente antes) e devolve status por destinatário.

const RECIPIENT_STATUS_LABEL = {
  pending: "Aguardando",
  sent:    "Enviado",
  failed:  "Falhou"
};

const RECIPIENT_STATUS_CLASS = {
  pending: "cs-pending",
  sent:    "cs-finished",
  failed:  "cs-cancelled"
};

let _campDetailsRecipients = [];

async function showCampaignDetails(id) {
  const c = _campaigns.find(c => String(c.id) === String(id));
  if (!c) { showToast("Campanha não encontrada."); return; }

  document.getElementById("_campaign-details-overlay")?.remove();

  const total  = Number(c.total_recipients || 0);
  const sent   = Number(c.sent_count || 0);
  const failed = Number(c.failed_count || 0);
  const label  = STATUS_LABEL[c.status] || c.status;
  const cls    = STATUS_CLASS[c.status] || "";

  const mediaHtml = !c.image_url ? "" : `
    <div class="camp-details-media">
      ${c.media_type === "pdf"
        ? `<div class="camp-details-media-pdf"><i class="fa-solid fa-file-pdf"></i> Anexo em PDF</div>`
        : c.media_type === "audio"
          ? `<div class="camp-details-media-audio"><audio controls src="${escapeAttr(safeUrl(c.image_url))}"></audio></div>`
          : `<img src="${escapeAttr(safeUrl(c.image_url))}" alt="">`
      }
    </div>`;

  const overlay = document.createElement("div");
  overlay.id = "_campaign-details-overlay";
  overlay.className = "campaign-confirm-overlay";
  overlay.innerHTML = `
    <div class="campaign-confirm-modal panel camp-details-modal">
      <div class="campaign-confirm-header">
        <i class="fa-solid fa-bullhorn"></i>
        <h3>${safe(c.title)}</h3>
        <span class="campaign-status-badge ${cls}" style="margin-left:auto;">${safe(label)}</span>
      </div>

      <div class="camp-details-meta">
        <span><i class="fa-solid fa-calendar"></i> Criada em ${_fmtDate(c.created_at)}</span>
        ${c.started_at  ? `<span><i class="fa-solid fa-play"></i> Iniciada em ${_fmtDate(c.started_at)}</span>` : ""}
        ${c.finished_at ? `<span><i class="fa-solid fa-flag-checkered"></i> Finalizada em ${_fmtDate(c.finished_at)}</span>` : ""}
      </div>

      ${mediaHtml}

      <div class="camp-details-message">${safe(c.message)}</div>

      <div class="camp-details-stats">
        <span><strong>${total}</strong> total</span>
        <span class="camp-td-sent"><strong>${sent}</strong> enviados</span>
        <span class="${failed > 0 ? "camp-td-failed" : ""}"><strong>${failed}</strong> falhas</span>
      </div>

      <div class="camp-details-recipients-header">
        <label>Destinatários (${total})</label>
        <input type="text" id="camp-details-search" class="camp-details-search-input" placeholder="Buscar por nome ou número...">
      </div>
      <div id="camp-details-recipients" class="camp-details-recipients">
        <div class="camp-picker-hint"><i class="fa-solid fa-spinner fa-spin"></i> Carregando...</div>
      </div>

      <div class="campaign-confirm-actions">
        <button type="button" class="history-clear-btn" id="_cdet-close-btn">Fechar</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector("#_cdet-close-btn")?.addEventListener("click", () => overlay.remove());

  const searchInput = overlay.querySelector("#camp-details-search");
  searchInput?.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = !q ? _campDetailsRecipients : _campDetailsRecipients.filter(r =>
      (r.contact_name || "").toLowerCase().includes(q) || String(r.user_id || "").toLowerCase().includes(q)
    );
    _renderCampaignDetailsRecipients(filtered);
  });

  let fetchError = false;
  try {
    const res = await apiFetch(`/api/broadcasts/${id}/recipients`);
    if (res?.ok) {
      const data = await res.json();
      _campDetailsRecipients = Array.isArray(data) ? data : [];
    } else {
      fetchError = true;
      _campDetailsRecipients = [];
    }
  } catch (err) {
    console.error("Erro ao buscar destinatários:", err);
    fetchError = true;
    _campDetailsRecipients = [];
  }

  // O modal pode já ter sido fechado enquanto a lista carregava
  const recipientsBox = document.getElementById("camp-details-recipients");
  if (!recipientsBox) return;

  if (fetchError) {
    recipientsBox.innerHTML = `<div class="camp-picker-hint">Erro ao carregar destinatários.</div>`;
    return;
  }

  _renderCampaignDetailsRecipients(_campDetailsRecipients);
}

function _renderCampaignDetailsRecipients(recipients) {
  const el = document.getElementById("camp-details-recipients");
  if (!el) return;

  if (!Array.isArray(recipients) || recipients.length === 0) {
    el.innerHTML = `<div class="camp-picker-hint">Nenhum destinatário encontrado.</div>`;
    return;
  }

  try {
    el.innerHTML = recipients.map(r => {
      const label = RECIPIENT_STATUS_LABEL[r.status] || r.status || "—";
      const cls   = RECIPIENT_STATUS_CLASS[r.status] || "";
      const phone = typeof formatContactPhone === "function"
        ? formatContactPhone(r.user_id)
        : (r.user_id || "");
      return `
        <div class="camp-details-recipient-item">
          <div class="cdr-info">
            <strong>${safe(r.contact_name || "(sem nome)")}</strong>
            <small>${safe(phone)}</small>
            ${r.error ? `<small class="cdr-error"><i class="fa-solid fa-triangle-exclamation"></i> ${safe(r.error)}</small>` : ""}
          </div>
          <span class="campaign-status-badge ${cls}">${safe(label)}</span>
        </div>`;
    }).join("");
  } catch (err) {
    console.error("Erro ao renderizar destinatários:", err);
    el.innerHTML = `<div class="camp-picker-hint">Erro ao exibir destinatários.</div>`;
  }
}
