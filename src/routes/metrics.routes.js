const express      = require("express");
const pool         = require("../database/postgres");
const asyncHandler = require("../utils/asyncHandler");

const router = express.Router();

// Timezone configurável via .env — evita hardcode por região
const TZ = process.env.TZ_NEGOCIO || "America/Maceio";

router.get("/metrics", asyncHandler(async (req, res) => {
  // Totais por status + total geral + criados hoje + criados no mês corrente
  const summaryRes = await pool.query(`
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
  `, [TZ]);

  // Totais por dia (últimos 30 dias) — timezone via parâmetro para evitar SQL injection
  const diaRes = await pool.query(`
    SELECT
      TO_CHAR(created_at AT TIME ZONE $1, 'DD/MM/YYYY') AS dia,
      COUNT(*)::int AS total
    FROM tickets
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY dia
    ORDER BY MIN(created_at) ASC
  `, [TZ]);

  // PEDIDO DO USUÁRIO (2026-07-27): "horário de pico" — em que hora do dia
  // chegam mais atendimentos, pra decidir escala/reforço de atendente. Mesma
  // janela de 30 dias do gráfico "por dia" acima, pra ficar consistente e
  // refletir o volume recente (não o histórico todo, que dilui picos atuais).
  const horaRes = await pool.query(`
    SELECT
      EXTRACT(HOUR FROM created_at AT TIME ZONE $1)::int AS hora,
      COUNT(*)::int AS total
    FROM tickets
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY hora
    ORDER BY hora ASC
  `, [TZ]);

  // PEDIDO DO USUÁRIO (2026-07-27): supervisora monitorando "quem está em
  // atendimento / quem não" e "quem atendeu mais" — uma única query agregada
  // (evita 1 consulta por atendente) juntando o cadastro de usuários ativos
  // com a contagem de tickets já assumidos por cada um (total histórico) e
  // quantos estão em_andamento AGORA. Status online/offline é resolvido no
  // frontend (window.onlineUsers, via socket.service.js) — não depende do
  // banco, é presença em tempo real da conexão com o painel.
  const atendentesRes = await pool.query(`
    SELECT
      u.id,
      u.nome,
      COUNT(t.id)::int AS total_atendidos,
      COUNT(t.id) FILTER (WHERE t.status = 'em_andamento')::int AS em_atendimento
    FROM users u
    LEFT JOIN tickets t ON t.assigned_to = u.id
    WHERE u.ativo = true
    GROUP BY u.id, u.nome
    ORDER BY total_atendidos DESC, u.nome ASC
  `);

  // Pesquisa de satisfação: média geral + por atendente (só tickets
  // avaliados — satisfaction_rating IS NOT NULL).
  const satisfacaoRes = await pool.query(`
    SELECT
      ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
      COUNT(*)::int AS total
    FROM tickets
    WHERE satisfaction_rating IS NOT NULL
  `);

  const satisfacaoAtendenteRes = await pool.query(`
    SELECT
      assigned_to_name AS nome,
      ROUND(AVG(satisfaction_rating)::numeric, 2) AS media,
      COUNT(*)::int AS total
    FROM tickets
    WHERE satisfaction_rating IS NOT NULL AND assigned_to_name IS NOT NULL
    GROUP BY assigned_to_name
    ORDER BY media DESC
  `);

  // Pedido do usuário (2026-07-21): feedback livre de "o que podemos
  // melhorar?", perguntado só quando a nota veio baixa (1 ou 2 — ver
  // SATISFACTION_LOW_THRESHOLD em ticket.service.js). Sem essa lista, o
  // texto ficava só no banco, sem lugar nenhum pro dono da loja ler — ver
  // migration 018. Limitado aos 50 mais recentes pra não pesar a página.
  // "<= 2" precisa ficar igual a SATISFACTION_LOW_THRESHOLD em
  // ticket.service.js — se mudar lá, mudar aqui também (não há import
  // compartilhado entre routes/ e services/ neste arquivo hoje).
  const feedbacksNegativosRes = await pool.query(`
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
  `);

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
  // agora).
  const atendentes = atendentesRes.rows.map(row => ({
    id:             row.id,
    nome:           row.nome,
    totalAtendidos: row.total_atendidos,
    emAtendimento:  row.em_atendimento > 0
  }));

  res.json({
    total,
    mensal:     s.mensal,
    hoje:       s.hoje,
    abertos:    s.abertos,
    andamento:  s.andamento,
    resolvidos: s.resolvidos,
    cancelados: s.cancelados,
    pendentes:  s.abertos + s.andamento,
    taxaResolucao,
    porDia,
    porHora,
    horarioPico: horarioPico ? { hora: horarioPico.hora, total: horarioPico.total } : null,
    atendentes,
    satisfacaoMedia:         satisfacaoRes.rows[0]?.media ? Number(satisfacaoRes.rows[0].media) : null,
    satisfacaoTotalRespostas: satisfacaoRes.rows[0]?.total || 0,
    satisfacaoPorAtendente,
    feedbacksNegativos: feedbacksNegativosRes.rows
  });
}));

module.exports = router;
