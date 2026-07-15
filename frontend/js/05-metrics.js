// 05-metrics.js

// Paleta coordenada com os accents dos cards (16-metrics.css)
const METRICS_PALETTE = [
  "#3b82f6", "#22c55e", "#ef4444", "#f59e0b",
  "#06b6d4", "#8b5cf6", "#14b8a6", "#fb923c"
];

function metricsReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Converte #rrggbb → rgba(r,g,b,a)
function metricsHexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Gradiente vertical para preenchimento de área (barra/linha)
function metricsAreaGradient(ctx, area, hex) {
  if (!area) return metricsHexToRgba(hex, 0.18);
  const g = ctx.createLinearGradient(0, area.top, 0, area.bottom);
  g.addColorStop(0, metricsHexToRgba(hex, 0.40));
  g.addColorStop(1, metricsHexToRgba(hex, 0.02));
  return g;
}

// Anima a contagem de 0 até o valor, com separador de milhar pt-BR
function animateMetric(el, to, suffix = "") {
  if (!el) return;
  const target = Number(to) || 0;

  if (metricsReducedMotion() || target === 0) {
    el.textContent = target.toLocaleString("pt-BR") + suffix;
    return;
  }

  const duration = 850;
  const start = performance.now();

  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
    el.textContent = Math.round(target * eased).toLocaleString("pt-BR") + suffix;
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// Liga/desliga o estado de carregamento no botão Atualizar
function setMetricsLoading(on) {
  const btn = document.querySelector(".metrics-refresh-btn");
  if (!btn) return;
  btn.classList.toggle("is-loading", on);
  btn.disabled = on;
}

async function loadMetricsCharts() {
  if (typeof Chart === "undefined") return;

  setMetricsLoading(true);

  try {
    const res = await apiFetch(`/api/metrics`);
    if (!res) return;

    const data = await res.json();

    // ── KPIs (com animação de contagem) ───────────────────────────────────────
    animateMetric(document.getElementById("metric-total"),      data.mensal);
    animateMetric(document.getElementById("metric-andamento"),  data.andamento);
    animateMetric(document.getElementById("metric-resolvidos"), data.resolvidos);
    animateMetric(document.getElementById("metric-cancelados"), data.cancelados);
    animateMetric(document.getElementById("metric-hoje"),       data.hoje);
    animateMetric(document.getElementById("metric-pendentes"),  data.pendentes);
    animateMetric(document.getElementById("metric-taxa-resolucao"), data.taxaResolucao, "%");

    const setorTop = document.getElementById("metric-setor-top");
    if (setorTop) {
      setorTop.textContent = data.setorMaisMovimentado
        ? `${data.setorMaisMovimentado.nome} (${data.setorMaisMovimentado.total})`
        : "—";
    }

    // Pedido do usuário: pesquisa de satisfação ao fechar atendimento —
    // média geral (card) + quebra por atendente (tabela), pra supervisor
    // acompanhar desempenho individual.
    const satisfacaoEl = document.getElementById("metric-satisfacao");
    if (satisfacaoEl) {
      satisfacaoEl.textContent = data.satisfacaoMedia != null
        ? `${data.satisfacaoMedia.toFixed(1)} ⭐`
        : "—";
    }

    const satisfacaoBody = document.getElementById("metric-satisfacao-atendente-body");
    if (satisfacaoBody) {
      const entradas = Object.entries(data.satisfacaoPorAtendente || {})
        .sort((a, b) => b[1].media - a[1].media);

      satisfacaoBody.innerHTML = entradas.length
        ? entradas.map(([nome, { media, total }]) => `
            <tr>
              <td>${safe(nome)}</td>
              <td>${media.toFixed(1)} ⭐</td>
              <td>${total}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="3" class="metric-satisfaction-empty">Nenhuma avaliação ainda.</td></tr>`;
    }

    // ── Gráfico de status (doughnut) ──────────────────────────────────────────
    upsertChart("metric-chart-status", "doughnut", {
      labels:   Object.keys(data.porStatus || {}),
      datasets: [{
        data:            Object.values(data.porStatus || {}),
        backgroundColor: METRICS_PALETTE,
        borderColor:     "rgba(0,0,0,0.25)",
        borderWidth:     2,
        hoverOffset:     8
      }]
    }, {
      cutout: "66%",
      plugins: { legend: { position: "bottom" } }
    });

    // ── Gráfico por setor (bar) ───────────────────────────────────────────────
    upsertChart("metric-chart-sector", "bar", {
      labels:   Object.keys(data.porSetor || {}),
      datasets: [{
        label:           "Atendimentos",
        data:            Object.values(data.porSetor || {}),
        backgroundColor: (c) => metricsAreaGradient(c.chart.ctx, c.chart.chartArea, "#3b82f6"),
        borderColor:     "#3b82f6",
        borderWidth:     1.5,
        borderRadius:    10,
        maxBarThickness: 56
      }]
    }, {
      plugins: { legend: { display: false } }
    });

    // ── Gráfico por dia (line) ────────────────────────────────────────────────
    const metricDay = upsertChart("metric-chart-day", "line", {
      labels:   Object.keys(data.porDia || {}),
      datasets: [{
        label:               "Atendimentos por dia",
        data:                Object.values(data.porDia || {}),
        tension:             0.38,
        fill:                true,
        backgroundColor:     (c) => metricsAreaGradient(c.chart.ctx, c.chart.chartArea, "#22c55e"),
        borderColor:         "#22c55e",
        borderWidth:         2.5,
        pointBackgroundColor:"#22c55e",
        pointBorderColor:    "rgba(0,0,0,0.30)",
        pointRadius:         3,
        pointHoverRadius:    6
      }]
    }, {
      plugins: { legend: { display: false } }
    });

    // Mantém referência global para compatibilidade com código que usa metricDayChart
    if (typeof AppState !== "undefined") AppState.metricDayChart = metricDay;

  } catch (err) {
    console.error("Erro métricas:", err);
  } finally {
    setMetricsLoading(false);
  }
}
