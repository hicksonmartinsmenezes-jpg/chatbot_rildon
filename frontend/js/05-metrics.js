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

// Mesmo formato usado no PDF (_formatarMin em metrics-pdf.service.js) —
// mantém os dois lugares consistentes ("47 min", "1h01", "sem dados").
function metricsFormatarMin(min) {
  if (min == null) return "sem dados";
  if (min < 60) return `${Math.round(min)} min`;
  const horas = Math.floor(min / 60);
  const resto = Math.round(min % 60);
  return resto > 0 ? `${horas}h${String(resto).padStart(2, "0")}` : `${horas}h`;
}

// Pedido do usuário (2026-07-31): indicador de tendência vs mês anterior nos
// cards de KPI. `invertido=true` pra métricas onde SUBIR é ruim (tempo de
// resolução/resposta) — nessas, uma seta pra cima vem em vermelho, não verde.
function metricTrendHtml(pct, invertido = false) {
  if (pct == null) return "";
  if (pct === 0) {
    return `<span class="metric-card-trend is-neutral"><i class="fa-solid fa-equals"></i> igual ao mês passado</span>`;
  }
  const subiu = pct > 0;
  const bom = invertido ? !subiu : subiu;
  const icone = subiu ? "fa-arrow-up" : "fa-arrow-down";
  return `<span class="metric-card-trend ${bom ? "is-good" : "is-bad"}"><i class="fa-solid ${icone}"></i> ${subiu ? "+" : ""}${pct}% vs mês passado</span>`;
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

    // Pedido do usuário (2026-07-31): comparação com o mês anterior — trend
    // no card de total, e dois cards novos de tempo (resolução / 1ª resposta)
    // com sua própria seta (invertida: tempo MENOR é o resultado bom).
    const t = data.tendencia || {};
    const totalTrendEl = document.getElementById("metric-total-trend");
    if (totalTrendEl) totalTrendEl.innerHTML = metricTrendHtml(t.totalVariacaoPct);

    const tempoResolucaoEl = document.getElementById("metric-tempo-resolucao");
    if (tempoResolucaoEl) tempoResolucaoEl.textContent = metricsFormatarMin(t.tempoResolucaoAtualMin);
    const tempoResolucaoTrendEl = document.getElementById("metric-tempo-resolucao-trend");
    if (tempoResolucaoTrendEl) tempoResolucaoTrendEl.innerHTML = metricTrendHtml(t.tempoResolucaoVariacaoPct, true);

    const tempoRespostaEl = document.getElementById("metric-tempo-resposta");
    if (tempoRespostaEl) tempoRespostaEl.textContent = metricsFormatarMin(t.tempoRespostaAtualMin);
    const tempoRespostaTrendEl = document.getElementById("metric-tempo-resposta-trend");
    if (tempoRespostaTrendEl) tempoRespostaTrendEl.innerHTML = metricTrendHtml(t.tempoRespostaVariacaoPct, true);

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
    // atendimento/quem não" e "quem atendeu mais". Status online/offline vem
    // de window.onlineUsers (12-socket.js), populado via socket
    // "online_users" — mesmo dado já usado na aba Usuários.
    //
    // PEDIDO DO USUÁRIO (2026-07-31): "total atendido" sozinho premia quem
    // está há mais tempo de casa, não quem foi mais produtivo AGORA — guarda
    // os dados e deixa o seletor de período (hoje/7 dias/mês/total) escolher
    // qual coluna ordena/exibe, sem precisar recarregar do backend de novo.
    window._metricsAtendentes = data.atendentes || [];
    renderMetricsAtendentesTable(window._metricsAtendentesPeriodo || "total");

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

    // ── Distribuição de notas de satisfação (bar) — pedido do usuário
    // (2026-07-31): média sozinha ("4.2⭐") esconde se veio de notas
    // concentradas em 4-5 ou de uma mistura de 5 e 1 que se cancelam na
    // média. Cor por nota: vermelho (1-2), âmbar (3), verde (4-5).
    const notas = data.distribuicaoNotas || {};
    const notasCores = { 1: "#ef4444", 2: "#f97316", 3: "#f59e0b", 4: "#84cc16", 5: "#22c55e" };
    upsertChart("metric-chart-notas", "bar", {
      labels:   Object.keys(notas).map(n => `Nota ${n}`),
      datasets: [{
        label:           "Avaliações",
        data:            Object.values(notas),
        backgroundColor: Object.keys(notas).map(n => notasCores[n] || "#3b82f6"),
        borderRadius:    10,
        maxBarThickness: 44
      }]
    }, {
      plugins: { legend: { display: false } }
    });

  } catch (err) {
    console.error("Erro métricas:", err);
  } finally {
    setMetricsLoading(false);
  }
}

// Pedido do usuário (2026-07-31): seletor de período (Hoje/7 dias/Mês/Total)
// pro ranking de Atendentes — troca a coluna usada pra ordenar/exibir sem
// precisar recarregar do backend (os 4 totais já vêm juntos em cada
// atendente, ver metrics.service.js/atendentes).
const METRICS_PERIODO_CAMPOS = {
  hoje:   { campo: "atendidosHoje",   rotulo: "Hoje" },
  semana: { campo: "atendidosSemana", rotulo: "7 dias" },
  mes:    { campo: "atendidosMes",    rotulo: "Mês" },
  total:  { campo: "totalAtendidos",  rotulo: "Total atendido" }
};

function renderMetricsAtendentesTable(periodo) {
  const atendentesBody = document.getElementById("metric-atendentes-body");
  if (!atendentesBody) return;

  const config = METRICS_PERIODO_CAMPOS[periodo] || METRICS_PERIODO_CAMPOS.total;
  const atendentes = [...(window._metricsAtendentes || [])]
    .sort((a, b) => (b[config.campo] || 0) - (a[config.campo] || 0));

  const headerEl = document.getElementById("metric-atendentes-count-header");
  if (headerEl) headerEl.textContent = config.rotulo;

  atendentesBody.innerHTML = atendentes.length
    ? atendentes.map((a) => {
        const online = window.onlineUsers?.some(u => u.id === a.id && u.online);
        return `
          <tr>
            <td>${safe(a.nome)}</td>
            <td>${online ? "🟢 Online" : "⚫ Offline"}</td>
            <td>${a.emAtendimento ? "🟠 Sim" : "—"}</td>
            <td>${a[config.campo] ?? 0}</td>
          </tr>
        `;
      }).join("")
    : `<tr><td colspan="4" class="metric-satisfaction-empty">Nenhum atendente cadastrado.</td></tr>`;
}

function setMetricsAtendentesPeriodo(periodo) {
  if (!METRICS_PERIODO_CAMPOS[periodo]) return;
  window._metricsAtendentesPeriodo = periodo;

  document.querySelectorAll("#metric-atendentes-periodo .metric-periodo-btn").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.periodo === periodo);
  });

  renderMetricsAtendentesTable(periodo);
}

// Pedido do usuário (2026-07-31): exportar o mesmo resumo do painel de
// Métricas em PDF, igual já existe pro Catálogo (ver exportarCatalogoPDF em
// 18-catalogo.js) — mesmo padrão de fetch+blob+download.
async function exportarMetricasPDF(btnEl) {
  const original = btnEl?.innerHTML;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Gerando PDF...</span>';
  }

  try {
    const res = await fetch(`/api/metrics/exportar-pdf`, { credentials: "include" });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || "Erro ao gerar PDF de métricas.");
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `metricas-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast?.(err.message || "Erro ao exportar métricas em PDF.", "error");
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = original;
    }
  }
}
