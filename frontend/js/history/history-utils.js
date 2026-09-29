// history-utils.js
// Helpers de histórico e resumo.


// PAGINAÇÃO DO HISTÓRICO (pedido do usuário, 2026-09-23): antes recebia o
// array inteiro (até 500 clientes) e calculava os 4 cards contando em cima
// dele no navegador — agora a tela só tem UMA PÁGINA de clientes carregada
// por vez, então essa conta ficaria errada (só refletiria a página atual).
// Os totais agora vêm prontos do backend (GET /api/history/grouped →
// summary, ver history.controller.js/history.repository.js
// getGroupedSummary), calculados via SQL sobre TODAS as linhas que batem
// no filtro — mais exato inclusive do que a versão antiga (que já cortava
// em 500 registros).
function updateHistorySummary(summary) {
  setText("history-total-count",    summary?.totalRegistros ?? 0);
  setText("history-client-count",   summary?.totalClientes  ?? 0);
  setText("history-today-count",    summary?.hoje           ?? 0);
  setText("history-response-count", summary?.comResposta    ?? 0);
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

