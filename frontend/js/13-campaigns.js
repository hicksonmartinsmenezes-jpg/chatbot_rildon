// 13-campaigns.js

async function loadCampaigns() {
  const list = document.getElementById("campaign-list");
  if (!list) return;

   loadCampaignStats();

  list.innerHTML = `<div class="loading">Carregando campanhas...</div>`;

  try {
    const res = await apiFetch("/api/broadcasts");
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = `<div class="empty">Nenhuma campanha criada ainda.</div>`;
      return;
    }


    const hasSendingCampaign = data.some(campaign => campaign.status === "sending");

    list.innerHTML = data.map(campaign => {
 const total = Number(campaign.total_recipients || 0);
  const sent = Number(campaign.sent_count || 0);
  const failed = Number(campaign.failed_count || 0);
  const processed = sent + failed;

  const progress = total > 0
    ? Math.min(100, Math.round((processed / total) * 100))
    : 0;

  return `
      <div class="campaign-item">
        <div>

  ${
    campaign.image_url
      ? `
      <img
        src="${campaign.image_url}"
        class="campaign-thumb"
      >
      `
      : ""
  }

         <strong>${safe(campaign.title)}</strong>
          <span>Status: ${safe(campaign.status)}</span>
          <small>
            Enviados: ${campaign.sent_count || 0} /
            ${campaign.total_recipients || 0}
            • Falhas: ${campaign.failed_count || 0}
          </small>

          <div class="campaign-progress-info">
            <span>${progress}% concluído</span>
            <span>${processed}/${total}</span>
            </div>

            <div class="campaign-progress">
            <div style="width: ${progress}%"></div>
            </div>


        </div>

        ${
          campaign.status === "pending"
            ? `<button onclick="startCampaign(${campaign.id})">
                <i class="fa-solid fa-play"></i>
                Iniciar
              </button>`
            : ""
        }
      </div>
     `;
    }).join("");    

    if (hasSendingCampaign) {
    setTimeout(loadCampaigns, 5000);
}

  } catch (err) {
    console.error("Erro campanhas:", err);
    list.innerHTML = `<div class="empty">Erro ao carregar campanhas.</div>`;
  }
}

async function createCampaign() {
  const titleInput = document.getElementById("campaign-title");
  const messageInput = document.getElementById("campaign-message");
  const recipientsInput = document.getElementById("campaign-recipients");

  const title = titleInput?.value.trim();
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
      const recipientsRaw = recipientsInput?.value.trim();

      if (!recipientsRaw) {
        showToast("Informe os destinatários personalizados.");
        return;
      }

      recipients = recipientsRaw
        .split(/\n|,|;/)
        .map(item => item.trim())
        .filter(Boolean);
    } else {
      const audienceRes = await apiFetch(`/api/broadcasts/audience/${audienceType}`);
      const audienceData = await audienceRes.json();

      if (!audienceRes.ok) {
        showToast(audienceData.error || "Erro ao buscar destinatários.");
        return;
      }

      recipients = audienceData;
    }

    if (!Array.isArray(recipients) || recipients.length === 0) {
      showToast("Nenhum destinatário encontrado.");
      return;
    }



     let imageUrl = null;

const imageInput =
  document.getElementById("campaign-image");

if (imageInput?.files?.length) {

  const formData = new FormData();

  formData.append(
    "image",
    imageInput.files[0]
  );

  const uploadRes = await fetch(
    "/api/broadcasts/upload",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${getSessionToken()}`
      },
      body: formData
    }
  );

  const uploadData =
    await uploadRes.json();

  if (!uploadRes.ok) {
    showToast(
      uploadData.error ||
      "Erro ao enviar imagem."
    );
    return;
  }

  imageUrl = uploadData.url;
}   




    const res = await apiFetch("/api/broadcasts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
         title,
        message,
        recipients,
        imageUrl
      })
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || "Erro ao criar campanha.");
      return;
    }

    showToast(`Campanha criada com ${recipients.length} destinatário(s).`);

    titleInput.value = "";
    messageInput.value = "";

    if (recipientsInput) {
      recipientsInput.value = "";
    }

    const imageInputReset =
  document.getElementById("campaign-image");

    const previewBox =
    document.getElementById("campaign-image-preview");

    const previewImg =
    document.getElementById("campaign-preview-img");

    if (imageInputReset) imageInputReset.value = "";
    if (previewBox) previewBox.classList.add("hidden");
    if (previewImg) previewImg.src = "";
    loadCampaigns();
    updateCampaignAudienceCount();
    loadCampaignStats();

  } catch (err) {
    console.error("Erro ao criar campanha:", err);
    showToast("Erro ao criar campanha.");
  }
}

async function startCampaign(id) {
  if (!confirm("Iniciar envio desta campanha?")) return;

  try {
    const res = await apiFetch(`/api/broadcasts/${id}/start`, {
      method: "POST"
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || "Erro ao iniciar campanha.");
      return;
    }

    showToast("Campanha iniciada.");
    loadCampaigns();
    loadCampaignStats();


  } catch (err) {
    console.error("Erro ao iniciar campanha:", err);
    showToast("Erro ao iniciar campanha.");
  }
}

function previewCampaignImage(event) {

  const file = event.target.files[0];

  if (!file) return;

  const img =
    document.getElementById("campaign-preview-img");

  const container =
    document.getElementById("campaign-image-preview");

  img.src = URL.createObjectURL(file);

  container.classList.remove("hidden");
}

function toggleCustomRecipients() {
  const selected =
    document.querySelector("input[name='campaign-audience']:checked")?.value;

  const box = document.getElementById("custom-recipients-box");

  if (!box) return;

  if (selected === "custom") {
    box.classList.remove("hidden");
  } else {
    box.classList.add("hidden");
  }

  updateCampaignAudienceCount();
}

async function updateCampaignAudienceCount() {

  if (!getSessionToken()) return;

  const countBox =
  document.getElementById("campaign-audience-count");
  if (!countBox) return;

  const audienceType =
    document.querySelector("input[name='campaign-audience']:checked")?.value || "custom";

  if (audienceType === "custom") {
    const raw = document.getElementById("campaign-recipients")?.value || "";

    const total = raw
      .split(/\n|,|;/)
      .map(item => item.trim())
      .filter(Boolean)
      .length;

    countBox.innerHTML = `${total} destinatário(s) personalizado(s).`;
    return;
  }

  countBox.innerHTML = "Calculando destinatários...";

  try {
    const res = await apiFetch(`/api/broadcasts/audience/${audienceType}`);
    const data = await res.json();

    if (!res.ok) {
      countBox.innerHTML = "Não foi possível calcular o público.";
      return;
    }

    countBox.innerHTML = `${data.length} destinatário(s) encontrado(s).`;
  } catch (err) {
    console.error("Erro ao calcular público:", err);
    countBox.innerHTML = "Erro ao calcular destinatários.";
  }
}

async function loadCampaignStats() {

  if (!getSessionToken()) return;

  try {
    const res = await apiFetch("/api/broadcasts/stats");
    const data = await res.json();

    if (!res.ok) return;

    document.getElementById("campaign-stat-total").textContent = data.campaigns || 0;
    document.getElementById("campaign-stat-sent").textContent = data.sent || 0;
    document.getElementById("campaign-stat-failed").textContent = data.failed || 0;
    document.getElementById("campaign-stat-success").textContent = `${data.successRate || 0}%`;

  } catch (err) {
    console.error("Erro estatísticas campanhas:", err);
  }
}

function switchCampaignPanel(panel, event) {
  document
    .querySelectorAll(".campaign-tab")
    .forEach(btn => btn.classList.remove("active"));

  event?.currentTarget?.classList.add("active");

  document
    .getElementById("campaign-panel-create")
    ?.classList.toggle("hidden", panel !== "create");

  document
    .getElementById("campaign-panel-monitor")
    ?.classList.toggle("hidden", panel !== "monitor");

  if (panel === "monitor") {
    loadCampaigns();
    loadCampaignStats();
  }

  if (panel === "create") {
    updateCampaignAudienceCount();
  }
}

