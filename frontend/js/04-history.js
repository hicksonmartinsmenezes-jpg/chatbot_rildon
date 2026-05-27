// 04-history.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Histórico ────────────────────────────────────────────────────────────────
async function loadHistory(render = true) {
  const search    = document.getElementById("search-history")?.value || "";
  const container = document.getElementById("history-container");

  if (render && container) container.innerHTML = `<p class="loading">Carregando histórico...</p>`;

  try {
    const params = new URLSearchParams();
    if (search) params.append("userId", search);
    params.append("limit", "100");

    const res = await apiFetch(`${BASE}/api/history?${params}`);
    if (!res) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

   const raw = await res.json();

    const history = Array.isArray(raw)
      ? raw
      : raw.data || [];

    if (render && container) {
      if (!history.length) {
        container.innerHTML = `<p class="empty">Nenhum histórico encontrado.</p>`;
      } else {
        container.innerHTML = history.map(item => `
          <div class="ticket-card">
            <div class="ticket-header">
              <span class="ticket-id">💬 ${formatPhone(item.userId)}</span>
              <span class="status-badge status-em_andamento">Histórico</span>
            </div>
            <p><strong>Mensagem:</strong> ${safe(item.message || "—")}</p>
            <p class="desc"><strong>Resposta:</strong><br>${safe(cutText(item.response || "—", 220))}</p>
            <p><strong>🕐</strong> ${formatDate(item.createdAt)}</p>
          </div>
        `).join("");
      }
    }
    return history;
  } catch {
    if (render && container)
      container.innerHTML = `<p class="empty">❌ Erro ao carregar histórico. Verifique se o servidor está rodando.</p>`;
    return [];
  }
}
