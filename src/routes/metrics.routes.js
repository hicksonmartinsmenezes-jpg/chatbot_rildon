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

  // Totais por setor
  const setorRes = await pool.query(`
    SELECT
      COALESCE(sector, 'geral') AS setor,
      COUNT(*)::int             AS total
    FROM tickets
    GROUP BY setor
    ORDER BY total DESC
  `);

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

  const s     = summaryRes.rows[0];
  const total = s.total;

  const porStatus = {
    aberto:       s.abertos,
    em_andamento: s.andamento,
    resolvido:    s.resolvidos,
    cancelado:    s.cancelados
  };

  const porSetor = {};
  for (const row of setorRes.rows) porSetor[row.setor] = row.total;

  const porDia = {};
  for (const row of diaRes.rows) porDia[row.dia] = row.total;

  const setorMaisMovimentado = setorRes.rows[0]
    ? { nome: setorRes.rows[0].setor, total: setorRes.rows[0].total }
    : { nome: "—", total: 0 };

  const taxaResolucao = total > 0
    ? Math.round((s.resolvidos / total) * 100)
    : 0;

  const satisfacaoPorAtendente = {};
  for (const row of satisfacaoAtendenteRes.rows) {
    satisfacaoPorAtendente[row.nome] = { media: Number(row.media), total: row.total };
  }

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
    setorMaisMovimentado,
    porStatus,
    porSetor,
    porDia,
    satisfacaoMedia:         satisfacaoRes.rows[0]?.media ? Number(satisfacaoRes.rows[0].media) : null,
    satisfacaoTotalRespostas: satisfacaoRes.rows[0]?.total || 0,
    satisfacaoPorAtendente
  });
}));

module.exports = router;
