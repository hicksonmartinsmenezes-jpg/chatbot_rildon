// 13-campaigns.js

async function loadCampaigns() {
  const list = document.getElementById("campaign-list");
  if (!list) return;

  list.innerHTML = `<div class="loading">Carregando campanhas...</div>`;

  try {
    const res = await apiFetch("/api/broadcasts");
    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = `<div class="empty">Nenhuma campanha criada ainda.</div>`;
      return;
    }

    list.innerHTML = data.map(campaign => `
      <div class="campaign-item">
        <div>
          <strong>${safe(campaign.title)}</strong>
          <span>Status: ${safe(campaign.status)}</span>
          <small>
            Enviados: ${campaign.sent_count || 0} /
            ${campaign.total_recipients || 0}
            • Falhas: ${campaign.failed_count || 0}
          </small>
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
    `).join("");

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

    const res = await apiFetch("/api/broadcasts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        message,
        recipients
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

    const imageInput = document.getElementById("campaign-image");
    const previewBox = document.getElementById("campaign-image-preview");
    const previewImg = document.getElementById("campaign-preview-img");

    if (imageInput) imageInput.value = "";
    if (previewBox) previewBox.classList.add("hidden");
    if (previewImg) previewImg.src = "";

    loadCampaigns();
    updateCampaignAudienceCount();

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
  const countBox = document.getElementById("campaign-audience-count");
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