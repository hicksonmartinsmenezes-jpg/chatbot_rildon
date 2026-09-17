/**
 * metrics.service.js — cálculo dos dados do painel de Métricas.
 *
 * Extraído de metrics.routes.js (2026-07-31) pra poder ser reaproveitado
 * também pelo export em PDF (metrics-pdf.service.js) sem duplicar as 10
 * queries — a rota GET /api/metrics e a rota de exportar PDF chamam a MESMA
 * função e cada uma faz o que quiser com o resultado (JSON vs desenhar PDF).
 *
 * 2026-09-16 (pedido do usuário: "quero apenas exportar métricas do mês
 * anterior não tenho opção disso"): `buscarMetricas` ganhou um parâmetro
 * opcional `mesRef` ("YYYY-MM") — SEM ele, continua se comportando
 * EXATAMENTE como antes (mês corrente, "últimos 30 dias" nos gráficos —
 * usado pelo painel ao vivo, GET /api/metrics, que nunca passa esse
 * parâmetro). COM ele (usado só pela exportação em PDF, ver
 * metrics.routes.js), os números "do mês" passam a ser sobre o mês
 * escolhido (do dia 1 ao último, no fuso TZ_NEGOCIO) em vez do corrente, e
 * os gráficos "por dia"/"por hora"/"por setor" (que hoje sempre mostram
 * "últimos 30 dias", independente de mês) passam a mostrar o mês inteiro
 * escolhido — do contrário um relatório de "Agosto" mostraria gráficos de
 * setembro (o rolling window de 30 dias corridos, sem relação com o mês do
 * relatório).
 *
 * Os limites do mês (início/fim, mês anterior, janela dos gráficos) são
 * resolvidos numa única query preliminar (`_resolverLimites`), reaproveitada
 * como parâmetro (timestamptz) em todas as 10 queries abaixo — troca as
 * comparações antigas `DATE_TRUNC('month', x) = DATE_TRUNC('month', NOW())`
 * por `x >= inicio AND x < fim` (mais simples de repetir por mês arbitrário,
 * e mais amigável a índice em created_at do que aplicar DATE_TRUNC em cada
 * linha da tabela).
 */
const pool = require("../database/postgres");

// Timezone configurável via .env — evita hardcode por região
const TZ = process.env.TZ_NEGOCIO || "America/Maceio";

// Ver comentário no topo do arquivo. `$2` (mesParam) é a string "YYYY-MM-01"
// do mês escolhido, ou NULL quando nenhum foi passado (mês corrente e
// janela de "últimos 30 dias", preservando o comportamento de sempre).
async function _resolverLimites(mesParam) {
  const { rows } = await pool.query(`
    SELECT
      (DATE_TRUNC('month', COALESCE($2::date, (NOW() AT TIME ZONE $1)::date)) AT TIME ZONE $1) AS mes_inicio,
      ((DATE_TRUNC('month', COALESCE($2::date, (NOW() AT TIME ZONE $1)::date)) + INTERVAL '1 month') AT TIME ZONE $1) AS mes_fim,
      ((DATE_TRUNC('month', COALESCE($2::date, (NOW() AT TIME ZONE $1)::date)) - INTERVAL '1 month') AT TIME ZONE $1) AS mes_anterior_inicio,
      CASE WHEN $2::date IS NULL THEN NOW() - INTERVAL '30 days'
           ELSE (DATE_TRUNC('month', $2::date) AT TIME ZONE $1) END AS janela_inicio,
      CASE WHEN $2::date IS NULL THEN NOW()
           ELSE ((DATE_TRUNC('month', $2::date) + INTERVAL '1 month') AT TIME ZONE $1) END AS janela_fim
  `, [TZ, mesParam]);
  return rows[0];
}

/**
 * @param {string|null} mesRef "YYYY-MM" opcional — ver comentário no topo do
 *   arquivo. Sem isso, comportamento idêntico ao de sempre (mês corrente).
 */
async function buscarMetricas(mesRef = null) {
  const mesParam = mesRef && /^\d{4}-\d{2}$/.test(mesRef) ? `${mesRef}-01` : null;
  const {
    mes_inicio: mesInicio,
    mes_fim: mesFim,
    mes_anterior_inicio: mesAnteriorInicio,
    janela_inicio: janelaInicio,
    janela_fim: janelaFim
  } = await _resolverLimites(mesParam);
  const [
    summaryRes,
    diaRes,
    horaRes,
    atendentesRes,
    satisfacaoRes,
    satisfacaoAtendenteRes,
    feedbacksNegativosRes,
    tendenciaRes,
    notasRes,
    setorRes,
    leadsRes,
    porMesRes
  ] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'aberto')::int AS abertos,
        COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS andamento,
        COUNT(*) FILTER (WHERE status = 'resolvido')::int AS resolvidos,
        COUNT(*) FILTER (WHERE status = 'cancelado')::int AS cancelados,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::int AS hoje,
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS mensal
      FROM tickets
    `, [mesInicio, mesFim]),

    pool.query(`
      SELECT
        TO_CHAR(created_at AT TIME ZONE $1, 'DD/MM/YYYY') AS dia,
        COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= $2 AND created_at < $3
      GROUP BY dia
      ORDER BY MIN(created_at) ASC
    `, [TZ, janelaInicio, janelaFim]),

    pool.query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE $1)::int AS hora,
        COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= $2 AND created_at < $3
      GROUP BY hora
      ORDER BY hora ASC
    `, [TZ, janelaInicio, janelaFim]),

    pool.query(`
      SELECT
        u.id,
        u.nome,
        COUNT(t.id)::int AS total_atendidos,
        COUNT(t.id) FILTER (WHERE t.status = 'em_andamento')::int AS em_atendimento,
        COUNT(t.id) FILTER (
          WHERE DATE(t.created_at AT TIME ZONE $1) = (NOW() AT TIME ZONE $1)::date
        )::int AS atendidos_hoje,
        COUNT(t.id) FILTER (WHERE t.created_at >= NOW() - INTERVAL '7 days')::int AS atendidos_semana,
        COUNT(t.id) FILTER (WHERE t.created_at >= $2 AND t.created_at < $3)::int AS atendidos_mes
      FROM users u
      LEFT JOIN tickets t ON t.assigned_to = u.id
      WHERE u.ativo = true
        AND LOWER(u.perfil) NOT IN ('admin', 'supervisor', 'api')
      GROUP BY u.id, u.nome
      ORDER BY total_atendidos DESC, u.nome ASC
    `, [TZ, mesInicio, mesFim]),

    // Pesquisa de satisfação: sem mesRef mantém todos os dados; com mesRef usa o mês selecionado.
    pool.query(`
      SELECT
        ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
        COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL
        AND ($3::date IS NULL OR (created_at >= $1 AND created_at < $2))
    `, [mesInicio, mesFim, mesParam]),

    pool.query(`
      SELECT
        assigned_to_name AS nome,
        ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
        COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL
        AND assigned_to_name IS NOT NULL
        AND ($3::date IS NULL OR (created_at >= $1 AND created_at < $2))
      GROUP BY assigned_to_name
      ORDER BY media DESC
    `, [mesInicio, mesFim, mesParam]),

    pool.query(`
      SELECT
        protocolo,
        customer_name AS "customerName",
        satisfaction_rating AS rating,
        satisfaction_feedback AS feedback,
        satisfaction_feedback_at AS "feedbackAt"
      FROM tickets
      WHERE satisfaction_rating <= 2
        AND satisfaction_feedback IS NOT NULL
        AND ($3::date IS NULL OR (created_at >= $1 AND created_at < $2))
      ORDER BY satisfaction_feedback_at DESC
      LIMIT 50
    `, [mesInicio, mesFim, mesParam]),

    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS mes_atual_total,
        COUNT(*) FILTER (
          WHERE created_at >= $1 AND created_at < $2 AND status = 'resolvido'
        )::int AS mes_atual_resolvidos,
        -- Pedido do usuário (2026-08-05): "Visão Geral" só com métricas do mês.
        COUNT(*) FILTER (
          WHERE created_at >= $1 AND created_at < $2 AND status = 'cancelado'
        )::int AS mes_atual_cancelados,
        COUNT(*) FILTER (WHERE created_at >= $3 AND created_at < $1)::int AS mes_anterior_total,
        COUNT(*) FILTER (
          WHERE created_at >= $3 AND created_at < $1 AND status = 'resolvido'
        )::int AS mes_anterior_resolvidos,
        ROUND((AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (
          WHERE status IN ('resolvido','cancelado') AND updated_at >= $1 AND updated_at < $2
        ))::numeric, 1) AS tempo_resolucao_atual_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (
          WHERE status IN ('resolvido','cancelado') AND updated_at >= $3 AND updated_at < $1
        ))::numeric, 1) AS tempo_resolucao_anterior_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (assumed_at - created_at)) / 60) FILTER (
          WHERE assumed_at IS NOT NULL AND assumed_at >= $1 AND assumed_at < $2
        ))::numeric, 1) AS tempo_resposta_atual_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (assumed_at - created_at)) / 60) FILTER (
          WHERE assumed_at IS NOT NULL AND assumed_at >= $3 AND assumed_at < $1
        ))::numeric, 1) AS tempo_resposta_anterior_min,
        -- Pedido do usuário (2026-09-17): "comparação ao mês anterior coloque
        -- avaliações também" — reaproveita esta MESMA query (já filtra
        -- atual/anterior por created_at) em vez de criar uma query nova só
        -- pra isso. IMPORTANTE: diferente do resto deste SELECT (que filtra
        -- por created_at), a pesquisa de satisfação só é respondida DEPOIS
        -- do ticket ser criado — mas aqui, igual ao restante da tabela
        -- "Comparação com o mês anterior", o recorte é por created_at do
        -- ticket (não por quando a nota foi dada), pra manter os 5 números
        -- da linha 'Avaliações' consistentes com todas as outras linhas da
        -- mesma tabela (todas recortadas por created_at do ticket).
        COUNT(*) FILTER (
          WHERE created_at >= $1 AND created_at < $2 AND satisfaction_rating IS NOT NULL
        )::int AS avaliacoes_atual,
        COUNT(*) FILTER (
          WHERE created_at >= $3 AND created_at < $1 AND satisfaction_rating IS NOT NULL
        )::int AS avaliacoes_mes_anterior
      FROM tickets
    `, [mesInicio, mesFim, mesAnteriorInicio]),

    pool.query(`
      SELECT satisfaction_rating AS nota, COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL
        AND ($3::date IS NULL OR (created_at >= $1 AND created_at < $2))
      GROUP BY satisfaction_rating
      ORDER BY satisfaction_rating ASC
    `, [mesInicio, mesFim, mesParam]),

    pool.query(`
      SELECT sector, COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY sector
      ORDER BY total DESC
    `, [janelaInicio, janelaFim]),

    pool.query(`
      SELECT COUNT(*)::int AS total
      FROM contacts
      WHERE 'Leads' = ANY(tags)
    `),

    // Pedido do usuário (2026-09-17): "coloque por grafico de meses
    // anteriores os atendimentos" no PDF — antes não existia nenhuma
    // agregação multi-mês, só "por dia" (últimos 30 dias/mês escolhido).
    // Janela generosa (6 meses pra trás de mesFim); o agrupamento por
    // TO_CHAR já bucketiza certo no fuso de negócio, igual diaRes acima —
    // os rótulos exatos dos 6 meses exibidos são recalculados em JS logo
    // abaixo (porMeses), essa query só faz o COUNT bruto por mês.
    pool.query(`
      SELECT
        TO_CHAR(created_at AT TIME ZONE $1, 'YYYY-MM') AS mes,
        COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= ($2::timestamptz - INTERVAL '6 months') AND created_at < $2
      GROUP BY mes
      ORDER BY mes ASC
    `, [TZ, mesFim])
  ]);

  const s = summaryRes.rows[0];
  const total = s.total;
  const porDia = {};
  for (const row of diaRes.rows) porDia[row.dia] = row.total;
  const porHora = {};
  for (let h = 0; h < 24; h++) porHora[h] = 0;
  for (const row of horaRes.rows) porHora[row.hora] = row.total;
  const horarioPico = horaRes.rows.length
    ? horaRes.rows.reduce((max, row) => (row.total > max.total ? row : max))
    : null;
  const taxaResolucao = total > 0 ? Math.round((s.resolvidos / total) * 100) : 0;
  const satisfacaoPorAtendente = {};
  for (const row of satisfacaoAtendenteRes.rows) {
    satisfacaoPorAtendente[row.nome] = { media: Number(row.media), total: row.total };
  }
  const atendentes = atendentesRes.rows.map(row => ({
    id: row.id,
    nome: row.nome,
    totalAtendidos: row.total_atendidos,
    emAtendimento: row.em_atendimento,
    atendidosHoje: row.atendidos_hoje,
    atendidosSemana: row.atendidos_semana,
    atendidosMes: row.atendidos_mes
  }));
  const distribuicaoNotas = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of notasRes.rows) distribuicaoNotas[row.nota] = row.total;
  const porSetor = {};
  for (const row of setorRes.rows) porSetor[row.sector || "geral"] = row.total;
  // Pedido do usuário (2026-09-17): "grafico de meses anteriores os
  // atendimentos" — monta os 6 rótulos "YYYY-MM" (mês do relatório + 5
  // anteriores) por aritmética inteira de ano/mês em JS, não por Date/TZ
  // (mesmo motivo do padrão já usado pra nomeMesExibido em
  // metrics-pdf.service.js: evita o risco de o objeto Date de mesInicio
  // "vazar" pro mês errado perto da virada, já que TIMESTAMPTZ é convertido
  // pro fuso do servidor Node ao virar objeto Date). Sem mesRef (painel ao
  // vivo/mês corrente), usa o ano/mês de "agora" — mesma convenção do resto
  // do arquivo pra esse caso.
  const [anoRef, mesNumRef] = mesParam
    ? [Number(mesParam.slice(0, 4)), Number(mesParam.slice(5, 7))]
    : (() => { const agora = new Date(); return [agora.getFullYear(), agora.getMonth() + 1]; })();
  const porMesMap = {};
  for (const row of porMesRes.rows) porMesMap[row.mes] = row.total;
  const porMeses = [];
  for (let i = 5; i >= 0; i--) {
    let ano = anoRef;
    let mes = mesNumRef - i;
    while (mes <= 0) { mes += 12; ano -= 1; }
    const chave = `${ano}-${String(mes).padStart(2, "0")}`;
    porMeses.push({ mes: chave, total: porMesMap[chave] || 0 });
  }
  const t = tendenciaRes.rows[0];
  function variacaoPercentual(atual, anterior) {
    if (atual == null || anterior == null || Number(anterior) === 0) return null;
    return Math.round(((Number(atual) - Number(anterior)) / Number(anterior)) * 100);
  }
  const taxaResolucaoAtual = t.mes_atual_total > 0
    ? Math.round((t.mes_atual_resolvidos / t.mes_atual_total) * 100)
    : 0;
  const taxaResolucaoMesAnterior = t.mes_anterior_total > 0
    ? Math.round((t.mes_anterior_resolvidos / t.mes_anterior_total) * 100)
    : 0;
  const tendencia = {
    totalMesAnterior: t.mes_anterior_total,
    resolvidosMesAnterior: t.mes_anterior_resolvidos,
    mesAtualResolvidos: t.mes_atual_resolvidos,
    mesAtualCancelados: t.mes_atual_cancelados,
    taxaResolucaoAtual,
    taxaResolucaoMesAnterior,
    taxaResolucaoVariacaoPontos: (t.mes_atual_total > 0 && t.mes_anterior_total > 0)
      ? taxaResolucaoAtual - taxaResolucaoMesAnterior
      : null,
    totalVariacaoPct: variacaoPercentual(t.mes_atual_total, t.mes_anterior_total),
    tempoResolucaoAtualMin: t.tempo_resolucao_atual_min != null ? Number(t.tempo_resolucao_atual_min) : null,
    tempoResolucaoAnteriorMin: t.tempo_resolucao_anterior_min != null ? Number(t.tempo_resolucao_anterior_min) : null,
    tempoResolucaoVariacaoPct: variacaoPercentual(t.tempo_resolucao_atual_min, t.tempo_resolucao_anterior_min),
    tempoRespostaAtualMin: t.tempo_resposta_atual_min != null ? Number(t.tempo_resposta_atual_min) : null,
    tempoRespostaAnteriorMin: t.tempo_resposta_anterior_min != null ? Number(t.tempo_resposta_anterior_min) : null,
    tempoRespostaVariacaoPct: variacaoPercentual(t.tempo_resposta_atual_min, t.tempo_resposta_anterior_min),
    avaliacoesAtual: t.avaliacoes_atual,
    avaliacoesMesAnterior: t.avaliacoes_mes_anterior,
    avaliacoesVariacaoPct: variacaoPercentual(t.avaliacoes_atual, t.avaliacoes_mes_anterior)
  };
  return {
    total,
    mensal: s.mensal,
    hoje: s.hoje,
    abertos: s.abertos,
    andamento: s.andamento,
    resolvidos: s.resolvidos,
    cancelados: s.cancelados,
    pendentes: s.abertos,
    taxaResolucao,
    porDia,
    porHora,
    porSetor,
    porMeses,
    horarioPico: horarioPico ? { hora: horarioPico.hora, total: horarioPico.total } : null,
    atendentes,
    satisfacaoMedia: satisfacaoRes.rows[0]?.media ? Number(satisfacaoRes.rows[0].media) : null,
    satisfacaoTotalRespostas: satisfacaoRes.rows[0]?.total || 0,
    satisfacaoPorAtendente,
    distribuicaoNotas,
    feedbacksNegativos: feedbacksNegativosRes.rows,
    tendencia,
    novosContatosLeads: leadsRes.rows[0]?.total || 0,
    mesRef: mesParam ? mesRef : null
  };
}

module.exports = { buscarMetricas };
