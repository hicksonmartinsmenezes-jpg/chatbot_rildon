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
    <div class="hrow" data-user-id="${escapeAttr(userId)}">
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

// Reconciliação incremental da tabela (em vez de reconstruir tudo do zero a
// cada loadHistory) — mesmo padrão/motivo de _loadConversationsCore em
// 07-conversations.js: reaproveita as linhas (.hrow) já no DOM pela chave
// data-user-id, só troca o conteúdo de quem mudou de verdade e reordena via
// appendChild. Evita "piscar" a tabela inteira a cada mensagem nova que o
// socket usa pra recarregar a aba Histórico aberta (12-socket.js).
function renderHistoryTable(container, groups) {
  let table = container.querySelector(".history-table");
  if (!table) {
    container.innerHTML = `
      <div class="history-table">
        <div class="hrow hrow-head">
          <span class="hrow-client">Cliente</span>
          <span class="hrow-count" style="display:flex;align-items:center;justify-content:center;">Atend.</span>
          <span class="hrow-date" style="display:flex;align-items:center;justify-content:center;">Última interação</span>
          <span class="hrow-actions">Ações</span>
        </div>
      </div>
    `;
    table = container.querySelector(".history-table");
  }

  const existingRows = new Map();
  table.querySelectorAll(":scope > .hrow:not(.hrow-head)").forEach(node => {
    if (node.dataset.userId) existingRows.set(node.dataset.userId, node);
  });

  const tmp = document.createElement("template");
  for (const group of groups) {
    const userId = group.latest.userId || group.latest.user_id || "";
    tmp.innerHTML = renderHistoryRow(group).trim();
    const fresh = tmp.content.firstElementChild;

    let node = existingRows.get(userId);
    if (node) {
      existingRows.delete(userId);
      if (node.innerHTML !== fresh.innerHTML) node.innerHTML = fresh.innerHTML;
    } else {
      node = fresh;
    }
    table.appendChild(node);
  }

  // Remove quem saiu da página atual (mudou de página/filtro)
  for (const node of existingRows.values()) node.remove();
}

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

// ─── Paginação (pedido do usuário, 2026-09-23: "meu histórico ainda
// carrega absolutamente todos, preciso que distribua 1-2-3 igual
// contatos") ────────────────────────────────────────────────────────────
// Mesmo padrão de estado do painel de Contatos (16-contacts.js:
// _contactsPage/_contactsTotal/_contactsLimit).
let _historyPage  = 1;
let _historyTotal = 0;
const _HISTORY_LIMIT = 40;

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
//
// PAGINAÇÃO (2026-09-23): antes buscava até 500 clientes de uma vez e
// renderizava tudo junto — travava com muitos clientes. Agora busca só
// _HISTORY_LIMIT (40) por vez, com `page`, igual o painel de Contatos. A
// filtragem client-side "de fallback" que existia aqui foi removida: ela
// rodava DEPOIS do limit/offset do servidor, então com paginação de
// verdade ela reduziria ainda mais uma página já cortada, quebrando a
// conta de totalPages (o backend já filtra de verdade — ver
// history.repository.js/_buildGroupedWhere — não é mais só um "quando o
// backend suportar").
async function loadHistory(render = true) {
  const search    = document.getElementById("search-history")?.value    || "";
  const startDate = document.getElementById("history-date-start")?.value || "";
  const endDate   = document.getElementById("history-date-end")?.value   || "";
  // Pedido do usuário (2026-07-30): filtro de horário do dia, além da data.
  const startTime = document.getElementById("history-time-start")?.value || "";
  const endTime   = document.getElementById("history-time-end")?.value   || "";
  const container = document.getElementById("history-container");

  // Só mostra o spinner de "Carregando..." quando ainda não existe uma
  // tabela na tela (1º carregamento real, ou depois de um estado vazio/erro).
  // ANTES, todo reload — inclusive os disparados em segundo plano pelo socket
  // a cada mensagem nova (ver 12-socket.js, _histReloadTimer) — sobrescrevia
  // a tabela inteira com o spinner e depois reconstruía tudo de novo, mesmo
  // com o usuário só olhando parado pra lista. Pedido do usuário (2026-09-23:
  // "a página atualiza sozinha, queria só que subisse a mensagem") — mesma
  // correção aplicada à lista de Conversas em 07-conversations.js.
  const jaTemTabela = !!container?.querySelector(".history-table");
  if (render && container && !jaTemTabela) {
    container.innerHTML = `
      <div class="history-loading">
        <i class="fa-solid fa-circle-notch fa-spin"></i>
        <span>Carregando histórico...</span>
      </div>
    `;
  }

  try {
    const params = new URLSearchParams();
    params.append("page",  String(_historyPage));
    params.append("limit", String(_HISTORY_LIMIT));

    if (search)    params.append("q",    search);
    if (startDate) params.append("from", startDate);
    if (endDate)   params.append("to",   endDate);
    if (startTime) params.append("horaInicio", startTime);
    if (endTime)   params.append("horaFim",    endTime);

    const res = await apiFetch(`${BASE}/api/history/grouped?${params}`);
    if (!res) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const raw     = await res.json();
    const history = Array.isArray(raw) ? raw : raw.data || [];

    _historyTotal = Number(raw.total) || 0;
    updateHistorySummary(raw.summary);
    renderHistoryFooter();

    if (render && container) {
      if (!history.length) {
        renderHistoryEmpty(container);
      } else {
        const groups = history.map(item => ({ latest: item, count: item.count || 1 }));
        renderHistoryTable(container, groups);
      }
    }

    return history;
  } catch (err) {
    console.error("[loadHistory]", err);
    updateHistorySummary(null);
    if (render && container) renderHistoryEmpty(container, "Erro ao carregar histórico.");
    return [];
  }
}

function renderHistoryFooter() {
  const showing = document.getElementById("history-showing");
  const pagInfo = document.getElementById("history-page-info");
  const btnPrev = document.getElementById("history-prev");
  const btnNext = document.getElementById("history-next");

  const totalPages = Math.max(1, Math.ceil(_historyTotal / _HISTORY_LIMIT));
  const start = (_historyPage - 1) * _HISTORY_LIMIT + 1;
  const end   = Math.min(_historyPage * _HISTORY_LIMIT, _historyTotal);

  if (showing) showing.textContent = _historyTotal > 0 ? `${start}–${end} de ${_historyTotal} clientes` : "0 clientes";
  if (pagInfo) pagInfo.textContent = `${_historyPage} / ${totalPages}`;
  if (btnPrev) btnPrev.disabled = _historyPage <= 1;
  if (btnNext) btnNext.disabled = _historyPage >= totalPages;
}

function historyPagePrev() {
  if (_historyPage > 1) { _historyPage--; loadHistory(true); }
}

function historyPageNext() {
  const totalPages = Math.ceil(_historyTotal / _HISTORY_LIMIT);
  if (_historyPage < totalPages) { _historyPage++; loadHistory(true); }
}

// Chamado por toda mudança de FILTRO (busca, datas, horários, botão
// atualizar — ver data-input-action/data-change-action/data-action
// "loadHistoryTrue" em 17-ui-events.js) — diferente dos cliques do pager
// (historyPagePrev/Next), que preservam _historyPage de propósito. Sem
// isso, filtrar a partir de uma página > 1 mandaria `page` desatualizado
// pro backend e podia voltar uma página vazia (mesmo bug que
// contactsSearch/contactsFilterTag evitam resetando _contactsPage em
// 16-contacts.js).
function loadHistoryFiltered() {
  _historyPage = 1;
  loadHistory(true);
}

function clearHistoryFilters() {
  ["search-history", "history-date-start", "history-date-end", "history-time-start", "history-time-end"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  _historyPage = 1;
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
