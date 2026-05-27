// 10-logs.js
// Arquivo modularizado automaticamente a partir do app.js original.

async function loadActivityLogs() {

  const container =
    document.getElementById("logs-container");

  if (!container) return;

  container.innerHTML =
    `<p class="loading">Carregando logs...</p>`;

  try {

    const res =
      await apiFetch(`${BASE}/api/activity-logs`);

    if (!res) return;

    const logs = await res.json();

    if (!logs.length) {

      container.innerHTML =
        `<p class="empty">Nenhum log encontrado.</p>`;

      return;
    }

    container.innerHTML = logs.map(log => `

      <div class="ticket-card">

        <div class="ticket-header">

          <span class="ticket-id">
            ${log.action}
          </span>

          <span class="status-badge status-em_andamento">
            ${new Date(log.createdAt)
              .toLocaleString("pt-BR")}
          </span>

        </div>

        <p>
          <strong>Usuário:</strong>
          ${log.userName}
        </p>

        <p class="desc">
          <strong>Ação:</strong><br>
          ${log.description}
        </p>

      </div>

    `).join("");

  } catch (err) {

    console.error(err);

    container.innerHTML =
      `<p class="empty">Erro ao carregar logs.</p>`;
  }
}
