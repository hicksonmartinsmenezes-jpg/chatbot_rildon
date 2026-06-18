// history-utils.js
// Helpers de histórico e resumo.

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

