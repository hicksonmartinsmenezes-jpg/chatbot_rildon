// 04-history.js
// Histórico executivo com filtros server-side, resumo e timeline.

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
    da.getMonth()    === db.getMonth()    &&
    da.getDate()     === db.getDate()
  );
}

function isHistoryInsideDateRange(item, start, end) {
  if (!start && !end) return true;
  if (!item?.createdAt) return false;
  const itemDate = new Date(item.createdAt);
  if (start) { const s = new Date(`${start}T00:00:00`); if (itemDate < s) return false; }
  if (end)   { const e = new Date(`${end}T23:59:59`);   if (itemDate > e) return false; }
  return true;
}

function updateHistorySummary(history) {
  const today   = new Date();
  const clients = new Set(history.map(item => item.userId).filter(Boolean));
  const todayCount    = history.filter(item => sameLocalDate(item.createdAt, today)).length;
  const responseCount = history.filter(item => item.response).length;

  setText("history-total-count",    history.length);
  setText("history-client-count",   clients.size);
  setText("history-today-count",    todayCount);
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

// Detecta se é um telefone BR real ou um ID interno do WhatsApp (LID)
function isBRPhone(formatted) {
  return /^\(\d{2}\)\s\d{4,5}-\d{4}$/.test(formatted);
}

function renderHistoryRow({ latest, count }) {
  const userId      = latest.userId || latest.user_id || "";
  const phoneRaw    = formatPhone(userId);
  const isPhone     = isBRPhone(phoneRaw);
  const contactName = latest.contactName || latest.contact_name || "Cliente";
  const nameDisplay = contactName !== "Cliente" ? contactName : phoneRaw;
  const sector      = latest.sector || "geral";
  const ident       = isPhone ? phoneRaw : "ID WhatsApp";

  return `
    <div class="hrow">
      <span class="hrow-client">
        ${avatarHtml(userId, nameDisplay)}
        <span class="hrow-info">
          <strong>${safe(nameDisplay)}</strong>
          <small>${safe(ident)}</small>
        </span>
      </span>
      <span class="hrow-sector" style="display:flex;align-items:center;justify-content:center;">
        <span class="history-sector">${safe(sector)}</span>
      </span>
      <span class="hrow-count" style="display:flex;align-items:center;justify-content:center;gap:5px;">
        ${count > 1 ? `<i class="fa-solid fa-clock-rotate-left"></i> ${count}` : `<span style="color:#334155">1</span>`}
      </span>
      <span class="hrow-date" style="display:flex;align-items:center;justify-content:center;">${safe(formatDate(latest.createdAt))}</span>
      <span class="hrow-actions">
        <button title="Ver conversa" onclick="openHistoryConversation('${escapeAttr(userId)}')">
          <i class="fa-solid fa-eye"></i>
        </button>
        <button title="Exportar TXT" class="btn-export-txt" onclick="exportHistoryTxt('${escapeAttr(userId)}', '${escapeAttr(nameDisplay)}')">
          <i class="fa-solid fa-file-arrow-down"></i>
        </button>
        <button title="Copiar identificador" onclick="copyHistoryPhone('${escapeAttr(phoneRaw)}')">
          <i class="fa-regular fa-copy"></i>
        </button>
      </span>
    </div>
  `;
}

// Mantém nome antigo como alias para não quebrar chamadas externas
const renderHistoryCard = renderHistoryRow;

async function exportHistoryTxt(userId, clientName) {
  try {
    showToast("Gerando arquivo...");
    const params = new URLSearchParams({ userId, limit: 200 });
    const res = await apiFetch(`${BASE}/api/history?${params}`);
    if (!res?.ok) { showToast("Erro ao exportar histórico."); return; }

    const raw   = await res.json();
    const items = (Array.isArray(raw) ? raw : raw.data || [])
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    if (!items.length) { showToast("Nenhum histórico encontrado."); return; }

    const phone = formatPhone(userId);
    const sep   = "─".repeat(50);
    const lines = [
      "=".repeat(52),
      `  HISTÓRICO DE CONVERSA`,
      "=".repeat(52),
      `  Cliente  : ${clientName}`,
      `  WhatsApp : ${phone}`,
      `  Registros: ${items.length}`,
      `  Exportado: ${new Date().toLocaleString("pt-BR")}`,
      "=".repeat(52),
      "",
    ];

    for (const item of items) {
      const date = item.createdAt
        ? new Date(item.createdAt).toLocaleString("pt-BR")
        : "Data desconhecida";
      lines.push(`[${date}]  Setor: ${item.sector || "geral"}`);
      lines.push(sep);
      if (item.message)  lines.push(`  CLIENTE : ${item.message}`);
      if (item.response) lines.push(`  BOT     : ${item.response}`);
      lines.push("");
    }

    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `historico_${clientName.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Histórico exportado com sucesso!");
  } catch (err) {
    console.error("Erro ao exportar:", err);
    showToast("Erro ao exportar histórico.");
  }
}

function groupHistoryByClient(history) {
  const map = {};
  for (const item of history) {
    const uid = item.userId || item.user_id || "";
    if (!uid) continue;
    if (!map[uid]) map[uid] = [];
    map[uid].push(item);
  }
  return Object.values(map)
    .map(items => {
      items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return { latest: items[0], count: items.length };
    })
    .sort((a, b) => new Date(b.latest.createdAt) - new Date(a.latest.createdAt));
}

// ─── loadHistory com filtros server-side (paginação futura via cursor) ────────
async function loadHistory(render = true) {
  const search    = document.getElementById("search-history")?.value    || "";
  const startDate = document.getElementById("history-date-start")?.value || "";
  const endDate   = document.getElementById("history-date-end")?.value   || "";
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
    params.append("limit", "100"); // Reduzido de 300 para 100

    // Envia filtros ao servidor quando disponíveis para reduzir payload
    if (search)    params.append("q",    search);
    if (startDate) params.append("from", startDate);
    if (endDate)   params.append("to",   endDate);

    const res = await apiFetch(`${BASE}/api/history?${params}`);
    if (!res) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw        = await res.json();
    const historyRaw = Array.isArray(raw) ? raw : raw.data || [];

    // Filtragem client-side como fallback (para backends que não suportam os params)
    const searchTerm = normalizeHistoryText(search);

    const history = historyRaw.filter(item => {
      const haystack = normalizeHistoryText([
        item.userId, item.user_id,
        item.contactName, item.contact_name,
        item.message, item.response,
        item.sector,
        formatPhone(item.userId || item.user_id)
      ].join(" "));

      const matchesSearch = !searchTerm || haystack.includes(searchTerm);
      const matchesDate   = isHistoryInsideDateRange(item, startDate, endDate);
      return matchesSearch && matchesDate;
    });

    updateHistorySummary(history);

    if (render && container) {
      if (!history.length) {
        renderHistoryEmpty(container);
      } else {
        const groups = groupHistoryByClient(history);
        container.innerHTML = `
          <div class="history-table">
            <div class="hrow hrow-head">
              <span class="hrow-client">Cliente</span>
              <span class="hrow-sector" style="display:flex;align-items:center;justify-content:center;">Setor</span>
              <span class="hrow-count" style="display:flex;align-items:center;justify-content:center;">Atend.</span>
              <span class="hrow-date" style="display:flex;align-items:center;justify-content:center;">Última interação</span>
              <span class="hrow-actions">Ações</span>
            </div>
            ${groups.map(renderHistoryRow).join("")}
          </div>
        `;
      }
    }

    return history;
  } catch (err) {
    console.error("[loadHistory]", err);
    updateHistorySummary([]);
    if (render && container) renderHistoryEmpty(container, "Erro ao carregar histórico.");
    return [];
  }
}

function clearHistoryFilters() {
  ["search-history", "history-date-start", "history-date-end"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  loadHistory(true);
}

async function openHistoryConversation(userId) {
  if (!userId) { showToast("Não foi possível abrir a conversa."); return; }
  switchTab("conversations");
  await loadConversations();
  openConversation(userId);
}

async function copyHistoryPhone(phone) {
  try {
    await navigator.clipboard.writeText(phone);
    showToast("📋 Número copiado!");
  } catch (_) {
    showToast("Não foi possível copiar o número.");
  }
}
