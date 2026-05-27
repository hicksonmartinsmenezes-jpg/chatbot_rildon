// 05-metrics.js
// Arquivo modularizado automaticamente a partir do app.js original.

async function loadMetricsCharts() {
  if (typeof Chart === "undefined") return;

  try {
    const res = await apiFetch(`${BASE}/api/metrics`);
    if (!res) return;

    const data = await res.json();

    const total = document.getElementById("metric-total");
    const andamento = document.getElementById("metric-andamento");
    const resolvidos = document.getElementById("metric-resolvidos");
    const cancelados = document.getElementById("metric-cancelados");

    if (total) total.innerHTML = data.total || 0;
    if (andamento) andamento.innerHTML = data.andamento || 0;
    if (resolvidos) resolvidos.innerHTML = data.resolvidos || 0;
    if (cancelados) cancelados.innerHTML = data.cancelados || 0;

    const statusCanvas = document.getElementById("metric-chart-status");

    if (statusCanvas) {
      if (window.metricStatusChart) {
        window.metricStatusChart.destroy();
      }

      window.metricStatusChart = new Chart(statusCanvas, {
        type: "doughnut",
        data: {
          labels: Object.keys(data.porStatus || {}),
          datasets: [{
            data: Object.values(data.porStatus || {}),
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

    const sectorCanvas = document.getElementById("metric-chart-sector");

    if (sectorCanvas) {
      if (window.metricSectorChart) {
        window.metricSectorChart.destroy();
      }

      window.metricSectorChart = new Chart(sectorCanvas, {
        type: "bar",
        data: {
          labels: Object.keys(data.porSetor || {}),
          datasets: [{
            label: "Atendimentos",
            data: Object.values(data.porSetor || {}),
            borderRadius: 10
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

    const dayCanvas = document.getElementById("metric-chart-day");

    if (dayCanvas) {
      if (metricDayChart) {
        metricDayChart.destroy();
      }

      metricDayChart = new Chart(dayCanvas, {
        type: "line",
        data: {
          labels: Object.keys(data.porDia || {}),
          datasets: [{
            label: "Atendimentos por dia",
            data: Object.values(data.porDia || {}),
            tension: 0.35,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false
        }
      });
    }

  } catch (err) {
    console.error("Erro métricas:", err);
  }
}
