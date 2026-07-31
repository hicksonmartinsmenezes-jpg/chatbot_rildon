// 04-history.js
// Histórico executivo com filtros server-side, resumo e timeline.

function renderHistoryRow({ latest, count }) {
  const userId      = latest.userId || latest.user_id || "";
  const phoneRaw    = formatPhone(userId);
  const isPhone     = isBRPhone(phoneRaw);
  const contactName = latest.contactName || latest.contact_name || "Cliente";
  const nameDisplay = contactName !== "Cliente" ? contactName : phoneRaw;
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
      <span class="hrow-count" style="display:flex;align-items:center;justify-content:center;gap:5px;">
        ${count > 1 ? `<i class="fa-solid fa-clock-rotate-left"></i> ${count}` : `<span style="color:#334155">1</span>`}
      </span>
      <span class="hrow-date" style="display:flex;align-items:center;justify-content:center;">${safe(formatDate(latest.createdAt))}</span>
      <span class="hrow-actions">
        <button type="button" title="Ver conversa" aria-label="Ver conversa" data-history-action="open" data-user-id="${escapeAttr(userId)}">
          <i class="fa-solid fa-eye"></i>
        </button>
        <button type="button" title="Exportar TXT" aria-label="Exportar histórico em TXT" class="btn-export-txt" data-history-action="export" data-user-id="${escapeAttr(userId)}" data-client-name="${escapeAttr(nameDisplay)}">
          <i class="fa-solid fa-file-arrow-down"></i>
        </button>
        <button type="button" title="Copiar identificador" aria-label="Copiar identificador" data-history-action="copy" data-phone="${escapeAttr(phoneRaw)}">
          <i class="fa-regular fa-copy"></i>
        </button>
      </span>
    </div>
  `;
}

// Mantém nome antigo como alias para não quebrar chamadas externas
const renderHistoryCard = renderHistoryRow;

function initHistoryDelegation() {
  const container = document.getElementById("history-container");
  if (!container || container.dataset.delegated === "1") return;
  container.dataset.delegated = "1";
  container.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-history-action]");
    if (!btn || !container.contains(btn)) return;
    const action = btn.dataset.historyAction;
    if (action === "open") openHistoryConversation(btn.dataset.userId || "");
    if (action === "export") exportHistoryTxt(btn.dataset.userId || "", btn.dataset.clientName || "Cliente");
    if (action === "copy") copyHistoryPhone(btn.dataset.phone || "");
  });
}

document.addEventListener("DOMContentLoaded", initHistoryDelegation);


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

// ─── loadHistory com filtros server-side ──────────────────────────────────────
// BUG CORRIGIDO (usuário: "sinto que não está salvando todas as
// conversas"): esta função buscava as N mensagens mais recentes de TODA A
// LOJA (LIMIT 100, sem paginação na tela) e agrupava por cliente aqui no
// navegador — assim que a loja passava de 100 mensagens desde a última
// visita à aba, clientes com conversas mais antigas simplesmente
// desapareciam da lista (os dados nunca saíram do banco, só não eram
// buscados). Agora usa /api/history/grouped, que já traz uma linha por
// cliente (mensagem mais recente + total de interações) direto do banco —
// ver history.repository.js (findGroupedByUser) para o motivo da mudança.
async function loadHistory(render = true) {
  const search    = document.getElementById("search-history")?.value    || "";
  const startDate = document.getElementById("history-date-start")?.value || "";
  const endDate   = document.getElementById("history-date-end")?.value   || "";
  // Pedido do usuário (2026-07-30): filtro de horário do dia, além da data.
  const startTime = document.getElementById("history-time-start")?.value || "";
  const endTime   = document.getElementById("history-time-end")?.value   || "";
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
    params.append("limit", "500");

    // Envia filtros ao servidor quando disponíveis para reduzir payload
    if (search)    params.append("q",    search);
    if (startDate) params.append("from", startDate);
    if (endDate)   params.append("to",   endDate);
    if (startTime) params.append("horaInicio", startTime);
    if (endTime)   params.append("horaFim",    endTime);

    const res = await apiFetch(`${BASE}/api/history/grouped?${params}`);
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
      const matchesDate   = isHistoryInsideDateRange(item, startDate, endDate, startTime, endTime);
      return matchesSearch && matchesDate;
    });

    updateHistorySummary(history);
    // updateHistorySummary conta 1 por linha — como cada linha aqui já é 1
    // cliente (visão agrupada), "Total de registros" ficaria igual a
    // "Clientes únicos". Corrige só esse card somando o total real de
    // interações (campo "count" de cada cliente).
    setText("history-total-count", history.reduce((acc, item) => acc + (item.count || 1), 0));

    if (render && container) {
      if (!history.length) {
        renderHistoryEmpty(container);
      } else {
        const groups = history.map(item => ({ latest: item, count: item.count || 1 }));
        container.innerHTML = `
          <div class="history-table">
            <div class="hrow hrow-head">
              <span class="hrow-client">Cliente</span>
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
  ["search-history", "history-date-start", "history-date-end", "history-time-start", "history-time-end"].forEach(id => {
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
