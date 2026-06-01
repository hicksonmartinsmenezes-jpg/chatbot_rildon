// 14-charts.js
// Utilitários centralizados de gráficos — evita duplicação entre
// 05-metrics.js e 06-tickets.js.

// ─── Opções padrão ────────────────────────────────────────────────────────────
function defaultChartOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: "#cbd5e1",
          boxWidth: 12,
          font: { weight: "bold" }
        }
      }
    },
    scales: {
      x: {
        ticks: { color: "#94a3b8" },
        grid:  { color: "rgba(255,255,255,.04)" }
      },
      y: {
        beginAtZero: true,
        ticks: { color: "#94a3b8", precision: 0 },
        grid:  { color: "rgba(255,255,255,.06)" }
      }
    },
    ...extra
  };
}

// ─── Fábrica de gráficos (cria ou atualiza no lugar) ──────────────────────────
/**
 * Cria o gráfico se ainda não existir no canvas, ou atualiza dados sem
 * destruir e recriar (melhor performance e sem piscada visual).
 *
 * @param {string|HTMLCanvasElement} canvasOrId
 * @param {string} type  — tipo Chart.js ("line", "bar", "doughnut", …)
 * @param {object} data  — { labels, datasets }
 * @param {object} [opts] — opções extras mescladas com defaultChartOptions
 * @returns {Chart|null}
 */
function upsertChart(canvasOrId, type, data, opts = {}) {
  if (typeof Chart === "undefined") return null;

  const canvas = typeof canvasOrId === "string"
    ? document.getElementById(canvasOrId)
    : canvasOrId;

  if (!canvas) return null;

  // Tenta recuperar instância existente via API oficial do Chart.js v3+
  const existing = Chart.getChart(canvas);

  if (existing) {
    existing.data.labels   = data.labels;
    existing.data.datasets = data.datasets;
    existing.update("none"); // "none" = sem animação na atualização, mais rápido
    return existing;
  }

  return new Chart(canvas, {
    type,
    data,
    options: defaultChartOptions(opts)
  });
}

// ─── Alias conveniente para as opções executivas (mantém retrocompat.) ─────────
function executiveChartOptions(extra = {}) {
  return defaultChartOptions(extra);
}
