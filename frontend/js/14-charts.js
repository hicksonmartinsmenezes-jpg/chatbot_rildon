// 14-charts.js
// Utilitários centralizados de gráficos — evita duplicação entre
// 05-metrics.js e 06-tickets.js.

// ─── Merge profundo de opções (preserva plugins/scales padrão) ────────────────
function deepMergeChartOptions(base, extra) {
  const out = { ...base };
  for (const key of Object.keys(extra || {})) {
    const bv = base ? base[key] : undefined;
    const ev = extra[key];
    if (ev && typeof ev === "object" && !Array.isArray(ev) &&
        bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[key] = deepMergeChartOptions(bv, ev);
    } else {
      out[key] = ev;
    }
  }
  return out;
}

// ─── Opções padrão ────────────────────────────────────────────────────────────
function defaultChartOptions(extra = {}) {
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 700, easing: "easeOutQuart" },
    interaction: { intersect: false },
    plugins: {
      legend: {
        labels: {
          color: "#cbd5e1",
          boxWidth: 12,
          usePointStyle: true,
          pointStyle: "circle",
          padding: 16,
          font: { weight: "bold", size: 12 }
        }
      },
      tooltip: {
        backgroundColor: "rgba(17,17,17,0.96)",
        borderColor: "rgba(255,255,255,0.10)",
        borderWidth: 1,
        padding: 12,
        cornerRadius: 12,
        titleColor: "#ffffff",
        bodyColor: "#cbd5e1",
        usePointStyle: true,
        titleFont: { weight: "800" },
        bodyFont: { weight: "600" }
      }
    },
    scales: {
      x: {
        ticks: { color: "#94a3b8", font: { weight: "600" } },
        grid:  { color: "rgba(255,255,255,.04)" }
      },
      y: {
        beginAtZero: true,
        ticks: { color: "#94a3b8", precision: 0, font: { weight: "600" } },
        grid:  { color: "rgba(255,255,255,.06)" }
      }
    }
  };

  return deepMergeChartOptions(base, extra);
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
    existing.options = defaultChartOptions(opts);
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
