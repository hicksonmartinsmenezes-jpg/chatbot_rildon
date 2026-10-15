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
 * opcional `mesRef` ("YYYY-MM") — SEM ele, os limites do mês (mesInicio/
 * mesFim) resolvem pro mês CORRENTE (ver COALESCE em `_resolverLimites`),
 * e os gráficos "por dia"/"por hora" usam janela de "últimos 30 dias"
 * corridos em vez do mês fechado (usado só pelo painel ao vivo, GET
 * /api/metrics, quando o seletor está em "Mês corrente" — a exportação em
 * PDF sempre passa um mesRef explícito, ver metrics.routes.js). COM
 * mesRef, os gráficos "por dia"/"por hora" também passam a mostrar o mês
 * inteiro escolhido — do contrário um relatório de "Agosto" mostraria
 * gráficos de setembro (o rolling window de 30 dias corridos, sem relação
 * com o mês do relatório).
 *
 * BUG CORRIGIDO (2026-09-17): até aqui, satisfação/notas/feedbacks tinham
 * um escape hatch que IGNORAVA o filtro de mês por completo quando mesRef
 * não era passado — mostravam dado ACUMULADO DESDE SEMPRE no painel ao
 * vivo mesmo com o seletor em "Mês corrente", enquanto os outros cards já
 * eram do mês. Removido: essas queries agora sempre filtram por
 * mesInicio/mesFim (que já é "mês corrente" quando mesRef é null), então
 * toda a resposta de `buscarMetricas` fica consistente com um único
 * recorte de tempo — corrente ou o mês escolhido, nunca uma mistura.
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
    estadoAtualRes,
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
    porMesRes,
    temposRes
  ] = await Promise.all([
    // BUG CORRIGIDO (varredura 2026-10-15): este SELECT não tinha WHERE
    // nenhum — total/abertos/resolvidos/cancelados/taxaResolucao saíam
    // ACUMULADOS DESDE SEMPRE (taxa de resolução dava 100%) com nomes
    // genéricos, lado a lado com os campos mensais. Agora tudo aqui é do
    // recorte do mês; o estado ATUAL (fila de agora, que não tem versão
    // "do mês") vem da query `estadoAtualRes` logo abaixo.
    // "hoje" também usava DATE(created_at) = CURRENT_DATE, os dois no fuso
    // do servidor (UTC no container): das 21h à meia-noite o "hoje" já era
    // o dia seguinte. Agora os dois lados são convertidos pro fuso do
    // negócio, igual ao resto do arquivo.
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'aberto')::int AS abertos,
        COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS andamento,
        COUNT(*) FILTER (WHERE status = 'resolvido')::int AS resolvidos,
        COUNT(*) FILTER (WHERE status = 'cancelado')::int AS cancelados,
        COUNT(*) FILTER (
          WHERE DATE(created_at AT TIME ZONE $3) = (NOW() AT TIME ZONE $3)::date
        )::int AS hoje,
        COUNT(*)::int AS mensal
      FROM tickets
      WHERE created_at >= $1 AND created_at < $2
    `, [mesInicio, mesFim, TZ]),

    // Estado atual da fila — sem recorte de tempo de propósito (é "foto de
    // agora": quantos estão esperando/sendo atendidos neste instante).
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'aberto')::int AS pendentes_agora,
        COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS em_atendimento_agora,
        COUNT(*)::int AS tickets_no_banco
      FROM tickets
    `),

    // BUG CORRIGIDO (varredura 2026-10-15): dias sem nenhum atendimento
    // simplesmente não apareciam — setembro saía com 20 pontos em vez de
    // 30 e a linha do gráfico ligava 12/09 direto em 15/09, como se o
    // movimento fosse contínuo. generate_series preenche o período inteiro
    // e os dias vazios entram com zero.
    pool.query(`
      SELECT
        TO_CHAR(d, 'DD/MM/YYYY') AS dia,
        COALESCE(t.total, 0)::int AS total
      FROM generate_series(
             ($2::timestamptz AT TIME ZONE $1)::date,
             (($3::timestamptz AT TIME ZONE $1) - INTERVAL '1 day')::date,
             INTERVAL '1 day'
           ) AS d
      LEFT JOIN (
        SELECT DATE(created_at AT TIME ZONE $1) AS dia, COUNT(*)::int AS total
        FROM tickets
        WHERE created_at >= $2 AND created_at < $3
        GROUP BY 1
      ) t ON t.dia = d::date
      ORDER BY d ASC
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

    // BUG CORRIGIDO (varredura 2026-10-15): a lista saía de `users` e
    // excluía admin/supervisor, então todo atendimento feito por um admin
    // sumia do relatório — setembro fechou com 195 atendimentos e a tabela
    // somava 158 (19% a menos). Quem fosse DESATIVADO também apagava o
    // próprio histórico. Agora a contagem parte dos TICKETS (quem de fato
    // atendeu aparece, ativo ou não, qualquer perfil), com uma linha "Sem
    // atendente" para os tickets que nunca foram assumidos, e os atendentes
    // ativos sem nenhum ticket entram zerados no fim da lista.
    pool.query(`
      WITH agg AS (
        SELECT
          assigned_to AS uid,
          MAX(assigned_to_name) AS nome_ticket,
          COUNT(*)::int AS total_atendidos,
          COUNT(*) FILTER (WHERE status = 'em_andamento')::int AS em_atendimento,
          COUNT(*) FILTER (
            WHERE DATE(created_at AT TIME ZONE $1) = (NOW() AT TIME ZONE $1)::date
          )::int AS atendidos_hoje,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS atendidos_semana,
          COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS atendidos_mes
        FROM tickets
        GROUP BY assigned_to
      )
      SELECT
        a.uid::text AS id,
        COALESCE(u.nome, a.nome_ticket, 'Sem atendente') AS nome,
        (a.uid IS NULL) AS sem_atendente,
        (a.uid IS NOT NULL AND u.id IS NULL) AS fora_do_cadastro,
        COALESCE(u.ativo, true) AS ativo,
        a.total_atendidos, a.em_atendimento, a.atendidos_hoje, a.atendidos_semana, a.atendidos_mes
      FROM agg a
      LEFT JOIN users u ON u.id = a.uid
      UNION ALL
      SELECT u.id::text, u.nome, false, false, u.ativo, 0, 0, 0, 0, 0
      FROM users u
      WHERE u.ativo = true
        AND LOWER(u.perfil) NOT IN ('api')
        AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.uid = u.id)
      ORDER BY atendidos_mes DESC, total_atendidos DESC, nome ASC
    `, [TZ, mesInicio, mesFim]),

    // BUG CORRIGIDO (2026-09-17, auditoria pedida pelo usuário: "verifique
    // todos os dados se batem perfeitamente"): esta query tinha um escape
    // hatch "$3::date IS NULL OR ..." que, sem mesRef (painel ao vivo, valor
    // padrão do seletor "Mês corrente"), IGNORAVA o filtro de data por
    // completo e mostrava a média de satisfação DESDE SEMPRE — enquanto o
    // <select> do painel rotula essa mesma opção como "Mês corrente" e os
    // cards ao lado (Atendimentos/Resolvidos/Taxa/TMA/TME) já eram do mês.
    // Provado com dado de teste: card "Avaliações" = 5 (acumulado) contra a
    // linha "Avaliações/Este mês" = 2 na tabela ao lado, na mesma tela.
    // Como mesInicio/mesFim já resolvem pra "mês corrente" quando mesParam é
    // NULL (ver COALESCE em _resolverLimites), basta sempre filtrar por eles
    // — não precisa mais do escape hatch nem do parâmetro $3 aqui.
    pool.query(`
      SELECT
        ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
        COUNT(*)::int AS total
      FROM tickets
      WHERE satisfaction_rating IS NOT NULL
        AND created_at >= $1 AND created_at < $2
    `, [mesInicio, mesFim]),

    // BUG CORRIGIDO (varredura 2026-10-15): agrupava por assigned_to_name
    // (texto gravado no ticket), então renomear o usuário criava DUAS
    // linhas pra mesma pessoa — o banco já tem "atendente"/"atendente02" e
    // "Hickson"/"Hickson02". Agora agrupa pelo id e usa o nome do cadastro
    // (caindo pro nome gravado no ticket só quando o usuário não existe
    // mais), igual à tabela de atendentes.
    pool.query(`
      SELECT
        COALESCE(u.nome, MAX(t.assigned_to_name), 'Sem atendente') AS nome,
        ROUND(AVG(t.satisfaction_rating)::numeric, 2) AS media,
        COUNT(*)::int AS total
      FROM tickets t
      LEFT JOIN users u ON u.id = t.assigned_to
      WHERE t.satisfaction_rating IS NOT NULL
        AND (t.assigned_to IS NOT NULL OR t.assigned_to_name IS NOT NULL)
        AND t.created_at >= $1 AND t.created_at < $2
      GROUP BY t.assigned_to, u.nome
      ORDER BY media DESC
    `, [mesInicio, mesFim]),

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
        AND created_at >= $1 AND created_at < $2
      ORDER BY satisfaction_feedback_at DESC
      LIMIT 50
    `, [mesInicio, mesFim]),

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
        -- Auditoria 2026-09-17: o TMA usava updated_at, que é "última
        -- alteração QUALQUER" (assumir, transferir, prependDescription
        -- também mexem nele — ver ticket.repository.js), não "instante do
        -- fechamento". Um ticket já fechado que recebesse qualquer edição
        -- depois migrava de mês e ainda inflava a duração medida.
        -- closed_at (migration 026) é gravado exatamente no fechamento.
        -- COALESCE porque tickets fechados ANTES daquela migration têm
        -- closed_at NULL — sem o fallback, o TMA de meses antigos zeraria
        -- de uma vez; com ele, dado novo fica exato e dado velho continua
        -- no melhor esforço de antes.
        -- Definição mantida de propósito: TMA = média dos atendimentos
        -- ENCERRADOS no mês (não dos abertos no mês) — por isso um ticket
        -- aberto dia 30/08 e fechado 02/09 entra no TMA de setembro com a
        -- duração cheia dos 3 dias. É o padrão de mercado pra esse
        -- indicador, mas explica TMA alto em mês que herdou fila do
        -- anterior.
        ROUND((AVG(EXTRACT(EPOCH FROM (COALESCE(closed_at, updated_at) - created_at)) / 60) FILTER (
          WHERE status IN ('resolvido','cancelado')
            AND COALESCE(closed_at, updated_at) >= $1 AND COALESCE(closed_at, updated_at) < $2
        ))::numeric, 1) AS tempo_resolucao_atual_min,
        ROUND((AVG(EXTRACT(EPOCH FROM (COALESCE(closed_at, updated_at) - created_at)) / 60) FILTER (
          WHERE status IN ('resolvido','cancelado')
            AND COALESCE(closed_at, updated_at) >= $3 AND COALESCE(closed_at, updated_at) < $1
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
        AND created_at >= $1 AND created_at < $2
      GROUP BY satisfaction_rating
      ORDER BY satisfaction_rating ASC
    `, [mesInicio, mesFim]),

    pool.query(`
      SELECT sector, COUNT(*)::int AS total
      FROM tickets
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY sector
      ORDER BY total DESC
    `, [mesInicio, mesFim]),

    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE 'Leads' = ANY(tags))::int AS leads_acumulado,
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS novos_no_mes
      FROM contacts
    `, [mesInicio, mesFim]),

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
    `, [TZ, mesFim]),

    // Varredura 2026-10-15: a MÉDIA de TMA/TME é dominada por atendimentos
    // que ficaram dias abertos (setembro deu TMA de 4d22h, com 143 tickets
    // acima de 24h). A mediana responde melhor "quanto demora um
    // atendimento normal". Também devolve a COBERTURA de cada indicador:
    // metade dos tickets não tem closed_at (cai no fallback updated_at) e
    // só parte deles tem assumed_at — sem isso o relatório mostra um número
    // preciso em cima de uma base incompleta, sem avisar ninguém.
    pool.query(`
      WITH base AS (
        SELECT
          status,
          created_at,
          assumed_at,
          closed_at IS NOT NULL AS tem_closed,
          COALESCE(closed_at, updated_at) AS fim,
          EXTRACT(EPOCH FROM (COALESCE(closed_at, updated_at) - created_at)) / 60 AS dur_min,
          EXTRACT(EPOCH FROM (assumed_at - created_at)) / 60 AS resp_min
        FROM tickets
      )
      SELECT
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dur_min) FILTER (
          WHERE status IN ('resolvido','cancelado') AND fim >= $1 AND fim < $2)::numeric, 1) AS tma_mediana_min,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY dur_min) FILTER (
          WHERE status IN ('resolvido','cancelado') AND fim >= $3 AND fim < $1)::numeric, 1) AS tma_mediana_anterior_min,
        COUNT(*) FILTER (WHERE status IN ('resolvido','cancelado') AND fim >= $1 AND fim < $2)::int AS tma_amostra,
        COUNT(*) FILTER (WHERE status IN ('resolvido','cancelado') AND fim >= $1 AND fim < $2 AND tem_closed)::int AS tma_com_fechamento,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resp_min) FILTER (
          WHERE assumed_at IS NOT NULL AND assumed_at >= $1 AND assumed_at < $2)::numeric, 1) AS tme_mediana_min,
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY resp_min) FILTER (
          WHERE assumed_at IS NOT NULL AND assumed_at >= $3 AND assumed_at < $1)::numeric, 1) AS tme_mediana_anterior_min,
        COUNT(*) FILTER (WHERE assumed_at IS NOT NULL AND assumed_at >= $1 AND assumed_at < $2)::int AS tme_amostra,
        COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)::int AS tickets_no_mes
      FROM base
    `, [mesInicio, mesFim, mesAnteriorInicio])
  ]);

  const s = summaryRes.rows[0];
  const estado = estadoAtualRes.rows[0];
  const tempos = temposRes.rows[0];
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
    semAtendente: row.sem_atendente === true,
    foraDoCadastro: row.fora_do_cadastro === true,
    ativo: row.ativo !== false,
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
    avaliacoesVariacaoPct: variacaoPercentual(t.avaliacoes_atual, t.avaliacoes_mes_anterior),
    // Mediana (valor de destaque no painel e no PDF) + cobertura — ver
    // comentário da query `temposRes` acima.
    tempoResolucaoMedianaMin: tempos.tma_mediana_min != null ? Number(tempos.tma_mediana_min) : null,
    tempoResolucaoMedianaAnteriorMin: tempos.tma_mediana_anterior_min != null ? Number(tempos.tma_mediana_anterior_min) : null,
    tempoResolucaoMedianaVariacaoPct: variacaoPercentual(tempos.tma_mediana_min, tempos.tma_mediana_anterior_min),
    tempoRespostaMedianaMin: tempos.tme_mediana_min != null ? Number(tempos.tme_mediana_min) : null,
    tempoRespostaMedianaAnteriorMin: tempos.tme_mediana_anterior_min != null ? Number(tempos.tme_mediana_anterior_min) : null,
    tempoRespostaMedianaVariacaoPct: variacaoPercentual(tempos.tme_mediana_min, tempos.tme_mediana_anterior_min),
    cobertura: {
      ticketsNoMes: tempos.tickets_no_mes,
      tmaAmostra: tempos.tma_amostra,
      tmaComFechamentoGravado: tempos.tma_com_fechamento,
      tmeAmostra: tempos.tme_amostra
    }
  };
  return {
    total,
    mensal: s.mensal,
    hoje: s.hoje,
    abertos: s.abertos,
    andamento: s.andamento,
    resolvidos: s.resolvidos,
    cancelados: s.cancelados,
    // "pendentes"/"andamento" são foto de AGORA (fila atual), não do mês —
    // por isso vêm da query de estado atual e têm nome próprio.
    pendentes: estado.pendentes_agora,
    pendentesAgora: estado.pendentes_agora,
    emAtendimentoAgora: estado.em_atendimento_agora,
    ticketsNoBanco: estado.tickets_no_banco,
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
    novosContatosLeads: leadsRes.rows[0]?.leads_acumulado || 0,
    novosContatosNoMes: leadsRes.rows[0]?.novos_no_mes || 0,
    mesRef: mesParam ? mesRef : null
  };
}

module.exports = { buscarMetricas };
