// 05-metrics.js

async function loadMetricsCharts() {
  if (typeof Chart === "undefined") return;

  try {
    const res = await apiFetch(`/api/metrics`);
    if (!res) return;

    const data = await res.json();

    const total     = document.getElementById("metric-total");
    const andamento = document.getElementById("metric-andamento");
    const resolvidos= document.getElementById("metric-resolvidos");
    const cancelados= document.getElementById("metric-cancelados");
    const hoje       = document.getElementById("metric-hoje");
    const pendentes  = document.getElementById("metric-pendentes");
    const taxa       = document.getElementById("metric-taxa-resolucao");
    const setorTop   = document.getElementById("metric-setor-top");

    if (total)      total.innerHTML     = data.total     || 0;
    if (andamento)  andamento.innerHTML = data.andamento  || 0;
    if (resolvidos) resolvidos.innerHTML= data.resolvidos || 0;
    if (cancelados) cancelados.innerHTML= data.cancelados || 0;
    if (hoje)      hoje.innerHTML      = data.hoje || 0;
    if (pendentes) pendentes.innerHTML = data.pendentes || 0;
    if (taxa)      taxa.innerHTML      = `${data.taxaResolucao || 0}%`;

    if (setorTop) {
      setorTop.innerHTML = data.setorMaisMovimentado
        ? `${data.setorMaisMovimentado.nome} (${data.setorMaisMovimentado.total})`
        : "—";
    }

    // ── Gráfico de status (doughnut) ──────────────────────────────────────────
    upsertChart("metric-chart-status", "doughnut", {
      labels:   Object.keys(data.porStatus  || {}),
      datasets: [{ data: Object.values(data.porStatus || {}), borderWidth: 2 }]
    });

    // ── Gráfico por setor (bar) ───────────────────────────────────────────────
    upsertChart("metric-chart-sector", "bar", {
      labels:   Object.keys(data.porSetor  || {}),
      datasets: [{
        label: "Atendimentos",
        data:  Object.values(data.porSetor || {}),
        borderRadius: 10
      }]
    });

    // ── Gráfico por dia (line) ────────────────────────────────────────────────
    const metricDay = upsertChart("metric-chart-day", "line", {
      labels:   Object.keys(data.porDia  || {}),
      datasets: [{
        label:   "Atendimentos por dia",
        data:    Object.values(data.porDia || {}),
        tension: 0.35,
        fill:    true
      }]
    });

    // Mantém referência global para compatibilidade com código que usa metricDayChart
    AppState.metricDayChart = metricDay;

  } catch (err) {
    console.error("Erro métricas:", err);
  }
}
