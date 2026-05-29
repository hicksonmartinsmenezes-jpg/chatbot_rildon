// 04-history.js
// Histórico executivo com filtros, resumo e timeline.

function normalizeHistoryText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function sameLocalDate(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);

  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

function isHistoryInsideDateRange(item, start, end) {
  if (!start && !end) return true;
  if (!item?.createdAt) return false;

  const itemDate = new Date(item.createdAt);

  if (start) {
    const startDate = new Date(`${start}T00:00:00`);
    if (itemDate < startDate) return false;
  }

  if (end) {
    const endDate = new Date(`${end}T23:59:59`);
    if (itemDate > endDate) return false;
  }

  return true;
}

function updateHistorySummary(history) {
  const today = new Date();
  const clients = new Set(history.map(item => item.userId).filter(Boolean));
  const todayCount = history.filter(item => sameLocalDate(item.createdAt, today)).length;
  const responseCount = history.filter(item => item.response).length;

  setText("history-total-count", history.length);
  setText("history-client-count", clients.size);
  setText("history-today-count", todayCount);
  setText("history-response-count", responseCount);
}

function renderHistoryEmpty(container, message = "Nenhum histórico encontrado.") {
  if (!container) return;

  container.innerHTML = `
    <div class="history-empty">
      <i class="fa-regular fa-comments"></i>
      <h3>${safe(message)}</h3>
      <p>Tente limpar os filtros ou atualizar a listagem.</p>
    </div>
  `;
}

function renderHistoryCard(item) {
  const userId = item.userId || item.user_id || "";
  const phone = formatPhone(userId);
  const contactName = item.contactName || item.contact_name || "Cliente";
  const message = item.message || "—";
  const response = item.response || "—";
  const sector = item.sector || "geral";

  return `
    <article class="history-card">
      <div class="history-card-marker"></div>

      <div class="history-card-header">
        <div class="history-avatar">
          <i class="fa-brands fa-whatsapp"></i>
        </div>

        <div class="history-client-info">
          <strong>${safe(contactName === "Cliente" ? phone : contactName)}</strong>
          <span>${safe(phone)}</span>
        </div>

        <div class="history-card-meta">
          <span class="history-sector">${safe(sector)}</span>
          <small>${safe(formatDate(item.createdAt))}</small>
        </div>
      </div>

      <div class="history-message-grid">
        <div class="history-message-box client-msg">
          <span><i class="fa-solid fa-user"></i> Cliente</span>
          <p>${safe(cutText(message, 260))}</p>
        </div>

        <div class="history-message-box bot-msg">
          <span><i class="fa-solid fa-robot"></i> Resposta enviada</span>
          <p>${safe(cutText(response, 320))}</p>
        </div>
      </div>

      <div class="history-card-actions">
        <button onclick="openHistoryConversation('${escapeAttr(userId)}')">
          <i class="fa-solid fa-comments"></i> Abrir conversa
        </button>

        <button onclick="copyHistoryPhone('${escapeAttr(phone)}')">
          <i class="fa-regular fa-copy"></i> Copiar número
        </button>
      </div>
    </article>
  `;
}

async function loadHistory(render = true) {
  const search = document.getElementById("search-history")?.value || "";
  const startDate = document.getElementById("history-date-start")?.value || "";
  const endDate = document.getElementById("history-date-end")?.value || "";
  const container = document.getElementById("history-container");

  if (render && container) {
    container.innerHTML = `
      <div class="history-loading">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
        <span>Carregando histórico...</span>
      </div>
    `;
  }

  try {
    const params = new URLSearchParams();
    params.append("limit", "300");

    const res = await apiFetch(`${BASE}/api/history?${params}`);
    if (!res) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw = await res.json();
    const historyRaw = Array.isArray(raw) ? raw : raw.data || [];

    const searchTerm = normalizeHistoryText(search);

    const history = historyRaw.filter(item => {
      const haystack = normalizeHistoryText([
        item.userId,
        item.user_id,
        item.contactName,
        item.contact_name,
        item.message,
        item.response,
        item.sector,
        formatPhone(item.userId || item.user_id)
      ].join(" "));

      const matchesSearch = !searchTerm || haystack.includes(searchTerm);
      const matchesDate = isHistoryInsideDateRange(item, startDate, endDate);

      return matchesSearch && matchesDate;
    });

    updateHistorySummary(history);

    if (render && container) {
      if (!history.length) {
        renderHistoryEmpty(container);
      } else {
        container.innerHTML = history.map(renderHistoryCard).join("");
      }
    }

    return history;
  } catch (err) {
    updateHistorySummary([]);

    if (render && container) {
      renderHistoryEmpty(container, "Erro ao carregar histórico.");
    }

    return [];
  }
}

function clearHistoryFilters() {
  setValue("search-history", "");
  setValue("history-date-start", "");
  setValue("history-date-end", "");
  loadHistory(true);
}

function openHistoryConversation(userId) {
  if (!userId) {
    showToast("Não foi possível abrir a conversa.");
    return;
  }

  switchTab("conversations");

  setTimeout(async () => {
    await loadConversations();
    openConversation(userId);
  }, 350);
}

async function copyHistoryPhone(phone) {
  try {
    await navigator.clipboard.writeText(phone);
    showToast("📋 Número copiado!");
  } catch (_) {
    showToast("Não foi possível copiar o número.");
  }
}
