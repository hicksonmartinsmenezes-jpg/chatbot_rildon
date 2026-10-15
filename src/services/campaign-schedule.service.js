const pool = require("../database/postgres");
const logger = require("../utils/logger");

const {
  createBroadcast,
  startBroadcast,
  getBroadcastAudience
} = require("./broadcast.service");

// Intervalo do tick do agendador — não precisa ser fino, agendamentos são
// campanhas de marketing (granularidade de minutos é mais que suficiente).
const TICK_MS = 60 * 1000;

function computeNextRun(fromDate, recurrence) {
  const next = new Date(fromDate);

  if (recurrence === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === "weekly") {
    next.setDate(next.getDate() + 7);
  } else if (recurrence === "monthly") {
    next.setMonth(next.getMonth() + 1);
  } else {
    return null; // sem recorrência — agendamento único, não repete
  }

  return next;
}

async function createSchedule({
  title,
  message,
  imageUrl,
  mediaType,
  audienceType,
  audienceTags,
  audienceAtendenteId,
  customRecipients,
  scheduledAt,
  recurrence,
  createdBy
}) {
  if (!title || !message) {
    throw new Error("Título e mensagem são obrigatórios.");
  }
  if (!scheduledAt) {
    throw new Error("Informe a data/hora do agendamento.");
  }

  const validTypes = ["all_clients", "contacts", "custom"];
  if (!validTypes.includes(audienceType)) {
    throw new Error("Tipo de público inválido.");
  }

  const validRecurrence = [null, undefined, "daily", "weekly", "monthly"];
  if (!validRecurrence.includes(recurrence || null)) {
    throw new Error("Recorrência inválida.");
  }

  if (audienceType === "custom" && (!Array.isArray(customRecipients) || customRecipients.length === 0)) {
    throw new Error("Informe ao menos um destinatário para público personalizado.");
  }

  const scheduledDate = new Date(scheduledAt);
  if (Number.isNaN(scheduledDate.getTime())) {
    throw new Error("Data/hora de agendamento inválida.");
  }

  const res = await pool.query(
    `
    INSERT INTO campaign_schedules
    (title, message, image_url, media_type,
     audience_type, audience_tags, audience_atendente_id, custom_recipients,
     scheduled_at, recurrence, next_run_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$11)
    RETURNING *
    `,
    [
      title,
      message,
      imageUrl || null,
      mediaType || null,
      audienceType,
      audienceType === "contacts" && Array.isArray(audienceTags) && audienceTags.length > 0 ? audienceTags : null,
      audienceType === "contacts" && audienceAtendenteId ? audienceAtendenteId : null,
      audienceType === "custom" ? JSON.stringify(customRecipients) : null,
      scheduledDate.toISOString(),
      recurrence || null,
      createdBy || null
    ]
  );

  logger.info(`[CampaignSchedule] Agendamento #${res.rows[0].id} criado ("${title}", ${recurrence || "único"}).`);
  return res.rows[0];
}

async function listSchedules() {
  const res = await pool.query(
    `SELECT * FROM campaign_schedules ORDER BY next_run_at ASC`
  );
  return res.rows;
}

async function getSchedule(id) {
  const res = await pool.query(`SELECT * FROM campaign_schedules WHERE id = $1`, [id]);
  if (!res.rows[0]) throw new Error("Agendamento não encontrado.");
  return res.rows[0];
}

async function pauseSchedule(id) {
  const res = await pool.query(
    `UPDATE campaign_schedules SET status = 'paused', updated_at = NOW()
     WHERE id = $1 AND status = 'active' RETURNING id`,
    [id]
  );
  if (res.rowCount === 0) throw new Error("Agendamento não encontrado ou não está ativo.");
  return { ok: true };
}

async function resumeSchedule(id) {
  const res = await pool.query(
    `UPDATE campaign_schedules SET status = 'active', updated_at = NOW()
     WHERE id = $1 AND status = 'paused' RETURNING id`,
    [id]
  );
  if (res.rowCount === 0) throw new Error("Agendamento não encontrado ou não está pausado.");
  return { ok: true };
}

async function cancelSchedule(id) {
  const res = await pool.query(
    `UPDATE campaign_schedules SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND status IN ('active','paused') RETURNING id`,
    [id]
  );
  if (res.rowCount === 0) throw new Error("Agendamento não encontrado ou já finalizado.");
  return { ok: true };
}

async function deleteSchedule(id) {
  const res = await pool.query(
    `DELETE FROM campaign_schedules WHERE id = $1 RETURNING id`,
    [id]
  );
  if (res.rowCount === 0) throw new Error("Agendamento não encontrado.");
  return { ok: true };
}

// Dispara uma linha vencida: resolve a audiência na hora (não usa lista
// congelada, exceto pra "custom"), cria e inicia a campanha normal, e
// atualiza o próprio agendamento (próxima data ou 'completed').
async function fireSchedule(schedule) {
  let recipients;

  if (schedule.audience_type === "custom") {
    recipients = schedule.custom_recipients || [];
  } else {
    recipients = await getBroadcastAudience(schedule.audience_type, {
      tags: schedule.audience_tags || [],
      atendenteId: schedule.audience_atendente_id || ""
    });
  }

  if (!recipients || recipients.length === 0) {
    logger.warn(`[CampaignSchedule] Agendamento #${schedule.id} sem destinatários no momento do disparo — pulado, tentará de novo na próxima recorrência.`);
  } else {
    const broadcast = await createBroadcast({
      title: schedule.title,
      message: schedule.message,
      recipients,
      createdBy: schedule.created_by,
      imageUrl: schedule.image_url,
      mediaType: schedule.media_type
    });

    await startBroadcast(broadcast.id);

    await pool.query(
      `UPDATE campaign_schedules SET last_run_at = NOW(), last_broadcast_id = $2 WHERE id = $1`,
      [schedule.id, broadcast.id]
    );

    logger.info(`[CampaignSchedule] Agendamento #${schedule.id} disparou campanha #${broadcast.id}.`);
  }

  const next = computeNextRun(schedule.next_run_at, schedule.recurrence);

  if (next) {
    await pool.query(
      `UPDATE campaign_schedules SET next_run_at = $2, updated_at = NOW() WHERE id = $1`,
      [schedule.id, next.toISOString()]
    );
  } else {
    await pool.query(
      `UPDATE campaign_schedules SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [schedule.id]
    );
  }
}

// Chamada pelo tick — busca agendamentos vencidos (ativos, next_run_at no
// passado) e dispara um por vez (evita sobrecarregar o WhatsApp caso vários
// vençam no mesmo minuto).
// 2026-10-09 (auditoria): o tick é de 60s, mas fireSchedule chama
// startBroadcast, que envia de verdade pelo WhatsApp com pausa entre
// destinatários — leva MUITO mais que 60s. Como o next_run_at só era
// atualizado no FIM de fireSchedule, o tick seguinte relia a mesma linha com
// next_run_at ainda no passado e DISPARAVA A MESMA CAMPANHA DE NOVO, mandando
// a mensagem repetida para os clientes. Com o servidor lento (o quadro de
// 01/10), isso acontecia a cada rodada.
//
// A guarda abaixo impede a reentrância. A correção completa seria reservar as
// linhas no próprio banco (UPDATE ... FOR UPDATE SKIP LOCKED antes de
// disparar); fica anotado, mas a guarda em processo já resolve para uma única
// instância do app, que é o caso aqui.
let _tickEmExecucao = false;

async function runDueSchedules() {
  if (_tickEmExecucao) {
    logger.warn("[CampaignSchedule] tick anterior ainda em execução — pulando este para não disparar a mesma campanha duas vezes.");
    return;
  }
  _tickEmExecucao = true;

  try {
    const res = await pool.query(
      `SELECT * FROM campaign_schedules WHERE status = 'active' AND next_run_at <= NOW() ORDER BY next_run_at ASC`
    );

    for (const schedule of res.rows) {
      try {
        await fireSchedule(schedule);
      } catch (err) {
        logger.error(`[CampaignSchedule] Erro ao disparar agendamento #${schedule.id}: ${err.message}`);
      }
    }
  } finally {
    _tickEmExecucao = false;
  }
}

function startScheduler() {
  setInterval(() => {
    runDueSchedules().catch(err => {
      logger.error(`[CampaignSchedule] Erro no tick do agendador: ${err.message}`);
    });
  }, TICK_MS).unref();

  logger.info("[CampaignSchedule] Agendador de campanhas iniciado.");
}

module.exports = {
  createSchedule,
  listSchedules,
  getSchedule,
  pauseSchedule,
  resumeSchedule,
  cancelSchedule,
  deleteSchedule,
  runDueSchedules,
  startScheduler
};
