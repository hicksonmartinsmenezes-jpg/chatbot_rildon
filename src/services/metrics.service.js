/**
 * metrics.service.js — cálculo dos dados do painel de Métricas.
 *
 * Extraído de metrics.routes.js (2026-07-31) pra poder ser reaproveitado
 * também pelo export em PDF (metrics-pdf.service.js) sem duplicar as 10
 * queries — a rota GET /api/metrics e a rota de exportar PDF chamam a MESMA
 * função e cada uma faz o que quiser com o resultado (JSON vs desenhar PDF).
 */
const pool = require("../database/postgres");

// Timezone configurável via .env — evita hardcode por região
const TZ = process.env.TZ_NEGOCIO || "America/Maceio";

async function buscarMetricas() {
  // Todas as queries abaixo são independentes entre si — Promise.all roda
  // tudo em paralelo (o tempo total passa a ser o da query mais lenta, não
  // a soma de todas) em vez do await sequencial de antes. Pedido do usuário
  // (2026-07-31): painel de Métricas ganhou bastante query nova (tempo
  // médio, comparação com mês anterior, ranking por período, distribuição
  // de notas, por setor) — rodar em série ficaria perceptivelmente mais
  // lento a cada atualização.
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
    setorRes
  ] = await Promise.all([
    // Totais por status + total geral + criados hoje + criados no mês corrente
    pool.query(`
      SELECT
        COUNT(*)::int                                                        AS total,
        COUNT(*) FILTER (WHERE status = 'aberto')::int                      AS abertos,
        COUNT(*) FILTER (WHERE status = 'em_andamento')::int                AS andamento,
        COUNT(*) FILTER (WHERE status = 'resolvido')::int                   AS resolvidos,
        COUNT(*) FILTER (WHERE status = 'cancelado')::int                   AS cancelados,
        COUNT(*) FILTER (WHERE DATE(created_at) = CURRENT_DATE)::int        AS hoje,
        COUNT(*) FILTER (
          WHERE DATE_TRUNC('month', created_at AT TIME ZONE $1)
              = DATE_TRUNC('month', NOW() AT TIME ZONE $1)
        )::int                                                              AS mensal
      FROM tickets
    `, [TZ]),

    // Totais por dia (últimos 30 dias) — timezone via parâmetro para evitar SQL injection
    pool.query(`
      SELECT
        TO_CHAR(created_at AT TIME ZONE $1, 'DD/MM/YYYY') AS dia,
        COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY dia
      ORDER BY MIN(created_at) ASC
    `, [TZ]),

    // PEDIDO DO USUÁRIO (2026-07-27): "horário de pico" — em que hora do dia
    // chegam mais atendimentos, pra decidir escala/reforço de atendente. Mesma
    // janela de 30 dias do gráfico "por dia" acima, pra ficar consistente e
    // refletir o volume recente (não o histórico todo, que dilui picos atuais).
    pool.query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE $1)::int AS hora,
        COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY hora
      ORDER BY hora ASC
    `, [TZ]),

    // PEDIDO DO USUÁRIO (2026-07-27): supervisora monitorando "quem está em
    // atendimento / quem não" e "quem atendeu mais" — uma única query agregada
    // (evita 1 consulta por atendente) juntando o cadastro de usuários ativos
    // com a contagem de tickets já assumidos por cada um (total histórico) e
    // quantos estão em_andamento AGORA. Status online/offline é resolvido no
    // frontend (window.onlineUsers, via socket.service.js) — não depende do
    // banco, é presença em tempo real da conexão com o painel.
    //
    // PEDIDO DO USUÁRIO (2026-07-31): "total atendido" sozinho premia quem
    // está há mais tempo de casa, não quem foi mais produtivo agora — soma
    // colunas de hoje/últimos 7 dias/mês corrente pro frontend deixar
    // escolher o período do ranking, sem perder o total histórico de antes.
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
        COUNT(t.id) FILTER (
          WHERE DATE_TRUNC('month', t.created_at AT TIME ZONE $1)
              = DATE_TRUNC('month', NOW() AT TIME ZONE $1)
        )::int AS atendidos_mes
      FROM users u
      LEFT JOIN tickets t ON t.assigned_to = u.id
      WHERE u.ativo = true
      GROUP BY u.id, u.nome
      ORDER BY total_atendidos DESC, u.nome ASC
    `, [TZ]),

    // Pesquisa de satisfação: média geral + por atendente (só tickets
    // avaliados — satisfaction_rating IS NOT NULL).
    pool.query(`
      SELECT
        ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
        COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL
    `),

    pool.query(`
      SELECT
        assigned_to_name AS nome,
        ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
        COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL AND assigned_to_name IS NOT NULL
      GROUP BY assigned_to_name
      ORDER BY media DESC
    `),

    // Pedido do usuário (2026-07-21): feedback livre de "o que podemos
    // melhorar?", perguntado só quando a nota veio baixa (1 ou 2 — ver
    // SATISFACTION_LOW_THRESHOLD em ticket.service.js). Sem essa lista, o
    // texto ficava só no banco, sem lugar nenhum pro dono da loja ler — ver
    // migration 018. Limitado aos 50 mais recentes pra não pesar a página.
    // "<= 2" precisa ficar igual a SATISFACTION_LOW_THRESHOLD em
    // ticket.service.js — se mudar lá, mudar aqui também (não há import
    // compartilhado entre routes/ e services/ neste arquivo hoje).
    pool.query(`
      SELECT
        protocolo,
        customer_name    AS "customerName",
        satisfaction_rating AS rating,
        satisfaction_feedback AS feedback,
        satisfaction_feedback_at AS "feedbackAt"
      FROM tickets
      WHERE satisfaction_rating <= 2
        AND satisfaction_feedback IS NOT NULL
      ORDER BY satisfaction_feedback_at DESC
      LIMIT 50
    `),

    // PEDIDO DO USUÁRIO (2026-07-31): painel só mostrava quantidade, nunca
    // tempo, e nunca comparava com o período anterior (não dava pra saber
    // se "312 atendimentos esse mês" é bom ou ruim sem saber quanto foi mês
    // passado). Uma query só, com FILTER pra mês atual e mês anterior lado a
    // lado — mesmo princípio das outras queries agregadas deste arquivo.
    // Tempo médio de resolução usa updated_at (quando fechou) dentro do mês;
    // tempo médio de 1ª resposta usa assumed_at (migration 022 — só existe
    // pra tickets assumidos depois dela, tickets antigos ficam de fora,
    // "sem dado" não é a mesma coisa que "zero").
    pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE DATE_TRUNC('month', created_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1)
        )::int AS mes_atual_total,
        COUNT(*) FILTER (
          WHERE DATE_TRUNC('month', created_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1)
            AND status = 'resolvido'
        )::int AS mes_atual_resolvidos,
        COUNT(*) FILTER (
          WHERE DATE_TRUNC('month', created_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1) - INTERVAL '1 month'
        )::int AS mes_anterior_total,
        COUNT(*) FILTER (
          WHERE DATE_TRUNC('month', created_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1) - INTERVAL '1 month'
            AND status = 'resolvido'
        )::int AS mes_anterior_resolvidos,
        ROUND((AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (
          WHERE status IN ('resolvido','cancelado')
            AND DATE_TRUNC('month', updated_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1)
        ))::numeric, 1) AS tempo_resolucao_atual_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (
          WHERE status IN ('resolvido','cancelado')
            AND DATE_TRUNC('month', updated_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1) - INTERVAL '1 month'
        ))::numeric, 1) AS tempo_resolucao_anterior_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (assumed_at - created_at)) / 60) FILTER (
          WHERE assumed_at IS NOT NULL
            AND DATE_TRUNC('month', assumed_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1)
        ))::numeric, 1) AS tempo_resposta_atual_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (assumed_at - created_at)) / 60) FILTER (
          WHERE assumed_at IS NOT NULL
            AND DATE_TRUNC('month', assumed_at AT TIME ZONE $1) = DATE_TRUNC('month', NOW() AT TIME ZONE $1) - INTERVAL '1 month'
        ))::numeric, 1) AS tempo_resposta_anterior_min
      FROM tickets
    `, [TZ]),

    // Pedido do usuário (2026-07-31): distribuição de notas (1 a 5) — uma
    // média sozinha ("4.2⭐") esconde se veio de notas concentradas em
    // 4-5 ou de uma mistura de 5 e 1 que se cancelam na média.
    pool.query(`
      SELECT satisfaction_rating AS nota, COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL
      GROUP BY satisfaction_rating
      ORDER BY satisfaction_rating ASC
    `),

    // Pedido do usuário (2026-07-31): "atendimentos por setor" existia no
    // Dashboard (executive view) mas não no painel de Métricas — últimos 30
    // dias, mesma janela do gráfico "por dia"/"por horário" acima.
    pool.query(`
      SELECT sector, COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY sector
      ORDER BY total DESC
    `)
  ]);

  const s     = summaryRes.rows[0];
  const total = s.total;

  const porDia = {};
  for (const row of diaRes.rows) porDia[row.dia] = row.total;

  // Todas as 24 horas aparecem no gráfico (mesmo com 0 atendimentos) — evita
  // eixo "furado" pulando direto de "9h" pra "14h" sem mostrar as vazias.
  const porHora = {};
  for (let h = 0; h < 24; h++) porHora[h] = 0;
  for (const row of horaRes.rows) porHora[row.hora] = row.total;

  const horarioPico = horaRes.rows.length
    ? horaRes.rows.reduce((max, row) => (row.total > max.total ? row : max))
    : null;

  const taxaResolucao = total > 0
    ? Math.round((s.resolvidos / total) * 100)
    : 0;

  const satisfacaoPorAtendente = {};
  for (const row of satisfacaoAtendenteRes.rows) {
    satisfacaoPorAtendente[row.nome] = { media: Number(row.media), total: row.total };
  }

  // PEDIDO DO USUÁRIO: monitoramento de atendentes — status online/offline é
  // resolvido no frontend (window.onlineUsers), aqui só entram os dados que
  // dependem do banco (quem atendeu quanto, quem tem ticket em_andamento
  // agora). atendidosHoje/Semana/Mes (2026-07-31) alimentam o seletor de
  // período do ranking no frontend — totalAtendidos (histórico) continua
  // sendo a ordenação padrão, sem quebrar quem já usava esse campo.
  const atendentes = atendentesRes.rows.map(row => ({
    id:             row.id,
    nome:           row.nome,
    totalAtendidos: row.total_atendidos,
    emAtendimento:  row.em_atendimento > 0,
    atendidosHoje:   row.atendidos_hoje,
    atendidosSemana: row.atendidos_semana,
    atendidosMes:    row.atendidos_mes
  }));

  // Distribuição de notas — zero-fill 1 a 5 (mesmo princípio de porHora
  // acima), senão uma nota que nunca foi dada simplesmente não aparece no
  // gráfico em vez de aparecer como "0".
  const distribuicaoNotas = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of notasRes.rows) distribuicaoNotas[row.nota] = row.total;

  const porSetor = {};
  for (const row of setorRes.rows) porSetor[row.sector || "geral"] = row.total;

  // Comparação com o mês anterior — % de variação (null quando não dá pra
  // calcular: mês anterior zerado, ou uma das pontas sem dado de tempo
  // ainda — ex: tempo de 1ª resposta só existe pra tickets assumidos depois
  // da migration 022, então o "mês anterior" pode legitimamente não ter
  // nenhum dado ainda por um tempo).
  const t = tendenciaRes.rows[0];
  function variacaoPercentual(atual, anterior) {
    if (atual == null || anterior == null || Number(anterior) === 0) return null;
    return Math.round(((Number(atual) - Number(anterior)) / Number(anterior)) * 100);
  }
  // BUG CORRIGIDO (2026-07-31): a tabela "Comparação com o mês anterior"
  // (metrics-pdf.service.js) comparava `data.taxaResolucao` (taxa ACUMULADA
  // desde sempre, calculada lá embaixo com `total`/`resolvidos` sem filtro
  // de mês) contra `taxaResolucaoMesAnterior` (taxa só do mês passado) —
  // maçãs com laranjas, já que a taxa acumulada mal se move mês a mês (é
  // diluída por todo o histórico). `taxaResolucaoAtual` abaixo usa
  // `mes_atual_total`/`mes_atual_resolvidos` (já vinham da mesma query,
  // só não eram usados pra essa conta) — agora as duas pontas da
  // comparação são taxas do MESMO tipo de período (mês vs mês anterior).
  // Variação em PONTOS percentuais (pp), não % da %, porque "taxa subiu de
  // 80% pra 85%" é "+5pp", não "+6.25%" — evita confundir o dono da loja.
  const taxaResolucaoAtual = t.mes_atual_total > 0
    ? Math.round((t.mes_atual_resolvidos / t.mes_atual_total) * 100)
    : 0;
  const taxaResolucaoMesAnterior = t.mes_anterior_total > 0
    ? Math.round((t.mes_anterior_resolvidos / t.mes_anterior_total) * 100)
    : 0;
  const tendencia = {
    totalMesAnterior:      t.mes_anterior_total,
    resolvidosMesAnterior: t.mes_anterior_resolvidos,
    taxaResolucaoAtual,
    taxaResolucaoMesAnterior,
    taxaResolucaoVariacaoPontos: (t.mes_atual_total > 0 && t.mes_anterior_total > 0)
      ? taxaResolucaoAtual - taxaResolucaoMesAnterior
      : null,
    totalVariacaoPct: variacaoPercentual(t.mes_atual_total, t.mes_anterior_total),
    tempoResolucaoAtualMin:      t.tempo_resolucao_atual_min != null ? Number(t.tempo_resolucao_atual_min) : null,
    tempoResolucaoAnteriorMin:   t.tempo_resolucao_anterior_min != null ? Number(t.tempo_resolucao_anterior_min) : null,
    tempoResolucaoVariacaoPct:   variacaoPercentual(t.tempo_resolucao_atual_min, t.tempo_resolucao_anterior_min),
    tempoRespostaAtualMin:       t.tempo_resposta_atual_min != null ? Number(t.tempo_resposta_atual_min) : null,
    tempoRespostaAnteriorMin:    t.tempo_resposta_anterior_min != null ? Number(t.tempo_resposta_anterior_min) : null,
    tempoRespostaVariacaoPct:    variacaoPercentual(t.tempo_resposta_atual_min, t.tempo_resposta_anterior_min)
  };

  return {
    total,
    mensal:     s.mensal,
    hoje:       s.hoje,
    abertos:    s.abertos,
    andamento:  s.andamento,
    resolvidos: s.resolvidos,
    cancelados: s.cancelados,
    // BUG CORRIGIDO (2026-07-31): estava `s.abertos + s.andamento`, somando
    // "em_andamento" (ticket JÁ assumido, sendo atendido agora) dentro de
    // "Pendentes". Em todo o resto do app, "Pendentes" = só status "aberto"
    // (sem atendente ainda) — ver ticket.controller.js linha ~102 ("'Pendentes'
    // (status 'aberto', sem atendente ainda)") e frontend/js/07-conversations.js
    // (estaPendente()). Com a fórmula antiga, o card "Pendentes" do painel de
    // Métricas (título "Tickets aguardando atendimento") mostrava um número
    // maior e DIFERENTE do badge de Pendentes usado no resto do painel —
    // contando de novo tickets que já têm dono e já estão sendo atendidos.
    pendentes:  s.abertos,
    taxaResolucao,
    porDia,
    porHora,
    porSetor,
    horarioPico: horarioPico ? { hora: horarioPico.hora, total: horarioPico.total } : null,
    atendentes,
    satisfacaoMedia:         satisfacaoRes.rows[0]?.media ? Number(satisfacaoRes.rows[0].media) : null,
    satisfacaoTotalRespostas: satisfacaoRes.rows[0]?.total || 0,
    satisfacaoPorAtendente,
    distribuicaoNotas,
    feedbacksNegativos: feedbacksNegativosRes.rows,
    tendencia
  };
}

module.exports = { buscarMetricas };
