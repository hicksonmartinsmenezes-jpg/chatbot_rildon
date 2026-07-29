// 05-metrics.js

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

    // PEDIDO DO USUÁRIO (2026-07-27): "horário de pico" no lugar do antigo
    // "setor destaque" (removido) — ajuda a decidir reforço de escala.
    const horarioPicoEl = document.getElementById("metric-horario-pico");
    if (horarioPicoEl) {
      horarioPicoEl.textContent = data.horarioPico
        ? `${String(data.horarioPico.hora).padStart(2, "0")}h (${data.horarioPico.total})`
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

    // Pedido do usuário (2026-07-21): feedback livre de "o que podemos
    // melhorar?" — perguntado só quando a nota veio baixa (1 ou 2). Sem essa
    // lista, o texto ficava só no banco, sem lugar nenhum pro dono da loja
    // ler (ver migration 018 e ticket.service.js).
    const feedbacksBody = document.getElementById("metric-feedbacks-negativos-body");
    if (feedbacksBody) {
      const feedbacks = data.feedbacksNegativos || [];
      feedbacksBody.innerHTML = feedbacks.length
        ? feedbacks.map((f) => `
            <tr>
              <td>#${safe(f.protocolo)}</td>
              <td>${safe(f.customerName || "Não informado")}</td>
              <td>${"⭐".repeat(f.rating)}</td>
              <td>${safe(cutText(f.feedback, 140))}</td>
              <td>${formatDate(f.feedbackAt)}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="5" class="metric-satisfaction-empty">Nenhum comentário registrado ainda.</td></tr>`;
    }

    // PEDIDO DO USUÁRIO (2026-07-27): supervisora monitorando "quem está em
    // atendimento/quem não" e "quem atendeu mais" — uma única tabela, já
    // ordenada pelo backend por total_atendidos DESC, cobre as duas
    // perguntas ao mesmo tempo (topo da lista = quem mais atendeu). Status
    // online/offline vem de window.onlineUsers (12-socket.js), populado via
    // socket "online_users" — mesmo dado já usado na aba Usuários.
    const atendentesBody = document.getElementById("metric-atendentes-body");
    if (atendentesBody) {
      const atendentes = data.atendentes || [];
      atendentesBody.innerHTML = atendentes.length
        ? atendentes.map((a) => {
            const online = window.onlineUsers?.some(u => u.id === a.id && u.online);
            return `
              <tr>
                <td>${safe(a.nome)}</td>
                <td>${online ? "🟢 Online" : "⚫ Offline"}</td>
                <td>${a.emAtendimento ? "🟠 Sim" : "—"}</td>
                <td>${a.totalAtendidos}</td>
              </tr>
            `;
          }).join("")
        : `<tr><td colspan="4" class="metric-satisfaction-empty">Nenhum atendente cadastrado.</td></tr>`;
    }

    // ── Gráfico por horário (bar) — pedido do usuário, no lugar do antigo
    // gráfico "por setor" (removido) ──────────────────────────────────────────
    upsertChart("metric-chart-hora", "bar", {
      labels:   Object.keys(data.porHora || {}).map(h => `${String(h).padStart(2, "0")}h`),
      datasets: [{
        label:           "Atendimentos",
        data:            Object.values(data.porHora || {}),
        backgroundColor: (c) => metricsAreaGradient(c.chart.ctx, c.chart.chartArea, "#3b82f6"),
        borderColor:     "#3b82f6",
        borderWidth:     1.5,
        borderRadius:    10,
        maxBarThickness: 32
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
