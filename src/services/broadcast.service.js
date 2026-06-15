const pool = require("../database/postgres");
const logger = require("../utils/logger");
const {
  sendMessage,
  sendMedia,
  resolveLid
} = require("../config/whatsapp");

const path = require("path");
const fs   = require("fs");

// Diretório canônico de imagens de campanhas — usado para validar paths
const CAMPAIGNS_DIR = path.resolve(__dirname, "../uploads/campaigns");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeUserId(userId) {
  if (!userId) return null;

  const value = String(userId).trim();

  if (value.endsWith("@s.whatsapp.net") || value.endsWith("@lid")) {
    return value;
  }

  const digits = value.replace(/\D/g, "");

  if (!digits) return null;

  return `${digits}@s.whatsapp.net`;
}

async function createBroadcast({ title, message, recipients, createdBy, imageUrl }) {
  if (!title || !message) {
    throw new Error("Título e mensagem são obrigatórios.");
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("Informe pelo menos um destinatário.");
  }

  const recipientMap = new Map();

for (const item of recipients) {
  const userId = normalizeUserId(item.userId || item.numero || item);
  const contactName = item.contactName || item.nome || "";

  if (userId && !recipientMap.has(userId)) {
    recipientMap.set(userId, { userId, contactName });
  }
}

const cleanedRecipients = Array.from(recipientMap.values());

  if (cleanedRecipients.length === 0) {
    throw new Error("Nenhum destinatário válido encontrado.");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const broadcastRes = await client.query(
      `
     INSERT INTO broadcasts
      (title, message, total_recipients, created_by, image_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [title, message, cleanedRecipients.length, createdBy || null, imageUrl || null]
    );

    const broadcast = broadcastRes.rows[0];

    for (const recipient of cleanedRecipients) {
      await client.query(
        `
        INSERT INTO broadcast_recipients
        (broadcast_id, user_id, contact_name)
        VALUES ($1, $2, $3)
        `,
        [broadcast.id, recipient.userId, recipient.contactName]
      );
    }

    await client.query("COMMIT");

    return broadcast;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// MELHORIA: paginação para não retornar sempre os mesmos 100 registros fixos
async function listBroadcasts({ page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;

  const res = await pool.query(
    `SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return res.rows;
}

async function getBroadcastRecipients(broadcastId) {
  const res = await pool.query(
    `
    SELECT *
    FROM broadcast_recipients
    WHERE broadcast_id = $1
    ORDER BY id ASC
    `,
    [broadcastId]
  );

  return res.rows;
}

async function startBroadcast(broadcastId) {
  // UPDATE atômico: só muda de 'pending' para 'sending', evitando race condition
  const updateRes = await pool.query(
    `UPDATE broadcasts SET status = 'sending', started_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [broadcastId]
  );

  if (updateRes.rowCount === 0) {
    const check = await pool.query(`SELECT status FROM broadcasts WHERE id = $1`, [broadcastId]);
    const b = check.rows[0];
    if (!b) throw new Error("Transmissão não encontrada.");
    if (b.status === "sending")   throw new Error("Esta transmissão já está em andamento.");
    if (b.status === "finished")  throw new Error("Esta transmissão já foi finalizada.");
    if (b.status === "cancelled") throw new Error("Esta transmissão foi cancelada.");
    throw new Error("Esta transmissão não pode ser iniciada.");
  }

  processBroadcastQueue(broadcastId).catch(err => {
    logger.error(`[Broadcast] Erro geral: ${err.message}`);
  });

  return { ok: true, message: "Transmissão iniciada." };
}

// MELHORIA: cancelamento de transmissão em andamento
async function cancelBroadcast(broadcastId) {
  const res = await pool.query(
    `UPDATE broadcasts
     SET status = 'cancelled', finished_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'sending')
     RETURNING id`,
    [broadcastId]
  );

  if (res.rowCount === 0) {
    throw new Error("Transmissão não encontrada ou não pode ser cancelada.");
  }

  logger.info(`[Broadcast] Transmissão ${broadcastId} cancelada.`);
  return { ok: true, message: "Transmissão cancelada." };
}

async function processBroadcastQueue(broadcastId) {
  const broadcastRes = await pool.query(
    `SELECT * FROM broadcasts WHERE id = $1`,
    [broadcastId]
  );

  const broadcast = broadcastRes.rows[0];
  if (!broadcast) return;

  const recipients = (await getBroadcastRecipients(broadcastId))
  .filter(item => item.status === "pending" || item.status === "failed");

 let sentCount = Number(broadcast.sent_count || 0);
  let failedCount = Number(broadcast.failed_count || 0);

  for (const recipient of recipients) {
    // MELHORIA: verificar se a transmissão foi cancelada a cada iteração
    const statusCheck = await pool.query(
      `SELECT status FROM broadcasts WHERE id = $1`,
      [broadcastId]
    );
    if (statusCheck.rows[0]?.status === "cancelled") {
      logger.info(`[Broadcast] Transmissão ${broadcastId} cancelada — interrompendo loop.`);
      return;
    }

    try {
      // Resolve JID @lid → número real (necessário para contatos via Linked Device)
      let targetUserId = recipient.user_id;
      if (targetUserId.endsWith("@lid")) {
        const resolved = resolveLid(targetUserId);
        if (resolved) {
          logger.info(`[Broadcast] LID resolvido: ${targetUserId} → ${resolved}`);
          targetUserId = resolved;
        } else {
          throw new Error(`Contato ${recipient.contact_name || targetUserId} usa Linked Device — aguarde ele enviar uma mensagem para o bot primeiro.`);
        }
      }

      if (broadcast.image_url) {
        const safeName  = path.basename(broadcast.image_url);
        const imagePath = path.join(CAMPAIGNS_DIR, safeName);

        if (!imagePath.startsWith(CAMPAIGNS_DIR + path.sep) && imagePath !== CAMPAIGNS_DIR) {
          throw new Error(`Path de imagem inválido: ${broadcast.image_url}`);
        }
        if (!fs.existsSync(imagePath)) {
          throw new Error(`Arquivo de imagem não encontrado: ${safeName}`);
        }

        await sendMedia(targetUserId, imagePath, broadcast.message);
      } else {
        await sendMessage(targetUserId, broadcast.message);
      }

      logger.info(`[Broadcast] ✓ Enviado para ${recipient.contact_name || targetUserId} (${broadcastId})`);

      await pool.query(
        `UPDATE broadcast_recipients SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = $1`,
        [recipient.id]
      );

      sentCount++;
      await pool.query(
        `UPDATE broadcasts SET sent_count = $1, failed_count = $2 WHERE id = $3`,
        [sentCount, failedCount, broadcastId]
      );

      await sleep(5000);
    } catch (err) {
      failedCount++;
      logger.warn(`[Broadcast] ✗ Falha para ${recipient.contact_name || recipient.user_id}: ${err.message}`);

      await pool.query(
        `UPDATE broadcast_recipients SET status = 'failed', error = $1 WHERE id = $2`,
        [err.message, recipient.id]
      );
      await pool.query(
        `UPDATE broadcasts SET sent_count = $1, failed_count = $2 WHERE id = $3`,
        [sentCount, failedCount, broadcastId]
      );

      await sleep(5000);
    }
  }

  await pool.query(
    `
    UPDATE broadcasts
    SET status = 'finished', finished_at = NOW()
    WHERE id = $1
    `,
    [broadcastId]
  );

  logger.info(`[Broadcast] Transmissão ${broadcastId} finalizada.`);
}


async function getBroadcastAudience(type, { tag = "", atendenteId = "" } = {}) {
  let query = "";
  let params = [];

  if (type === "all_clients") {
    query = `
SELECT
  user_id,
  MAX(contact_name) AS contact_name
  FROM history
  WHERE user_id IS NOT NULL
  GROUP BY user_id
  ORDER BY MAX(contact_name) NULLS LAST, user_id
    `;
  }

  if (type === "with_tickets") {
    query = `
     SELECT
  user_id,
  MAX(customer_name) AS contact_name
  FROM tickets
  WHERE user_id IS NOT NULL
  GROUP BY user_id
  ORDER BY MAX(customer_name) NULLS LAST, user_id
    `;
  }

  if (type === "last_30_days") {
    query = `
      SELECT
  user_id,
  MAX(contact_name) AS contact_name
  FROM history
  WHERE user_id IS NOT NULL
  AND created_at >= NOW() - INTERVAL '30 days'
  GROUP BY user_id
  ORDER BY MAX(contact_name) NULLS LAST, user_id
    `;
  }

  if (type === "contacts") {
    const where = ["status = 'ativo'", "whatsapp IS NOT NULL"];
    if (tag) {
      params.push(tag);
      where.push(`$${params.length} = ANY(tags)`);
    }
    if (atendenteId) {
      params.push(atendenteId);
      where.push(`atendente_id = $${params.length}::uuid`);
    }
    query = `
      SELECT whatsapp AS user_id, nome AS contact_name
      FROM contacts
      WHERE ${where.join(" AND ")}
      ORDER BY lower(nome)
    `;
  }

  if (!query) {
    throw new Error("Tipo de público inválido.");
  }

  const res = await pool.query(query, params);

  return res.rows.map(item => ({
    userId: item.user_id,
    contactName: item.contact_name || ""
  }));
}

async function getBroadcastStats() {
  const res = await pool.query(`
    SELECT
      COUNT(*)::int AS campaigns,
      COALESCE(SUM(sent_count), 0)::int AS sent,
      COALESCE(SUM(failed_count), 0)::int AS failed,
      COALESCE(SUM(total_recipients), 0)::int AS total_recipients
    FROM broadcasts
  `);

  const stats = res.rows[0];

  const totalAttempts = stats.sent + stats.failed;

  return {
    campaigns: stats.campaigns,
    sent: stats.sent,
    failed: stats.failed,
    successRate: totalAttempts > 0
      ? Math.round((stats.sent / totalAttempts) * 100)
      : 0
  };
}

async function deleteBroadcast(broadcastId) {
  const res = await pool.query(
    `DELETE FROM broadcasts WHERE id = $1 AND status <> 'sending' RETURNING id`,
    [broadcastId]
  );
  if (res.rowCount === 0) {
    throw new Error("Campanha não encontrada ou está em envio e não pode ser excluída.");
  }
  logger.info(`[Broadcast] Transmissão ${broadcastId} excluída.`);
  return { ok: true };
}

async function retryFailedRecipients(broadcastId) {
  const broadcastRes = await pool.query(
    `SELECT * FROM broadcasts WHERE id = $1`,
    [broadcastId]
  );
  const broadcast = broadcastRes.rows[0];
  if (!broadcast) throw new Error("Transmissão não encontrada.");
  if (broadcast.status === "sending") throw new Error("Transmissão já está em andamento.");

  const failedRes = await pool.query(
    `SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed'`,
    [broadcastId]
  );
  const failedCount = Number(failedRes.rows[0].count);
  if (failedCount === 0) throw new Error("Nenhum destinatário com falha encontrado.");

  // Reset failed recipients para pending
  await pool.query(
    `UPDATE broadcast_recipients SET status = 'pending', error = NULL, sent_at = NULL
     WHERE broadcast_id = $1 AND status = 'failed'`,
    [broadcastId]
  );

  // Recalcula total e zera contador de falhas
  const totalRes = await pool.query(
    `SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1`,
    [broadcastId]
  );

  await pool.query(
    `UPDATE broadcasts
     SET status = 'sending', started_at = NOW(),
         total_recipients = $2,
         sent_count = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent'),
         failed_count = 0
     WHERE id = $1`,
    [broadcastId, Number(totalRes.rows[0].count)]
  );

  processBroadcastQueue(broadcastId).catch(err =>
    logger.error(`[Broadcast] Erro retry: ${err.message}`)
  );

  logger.info(`[Broadcast] Retry de ${failedCount} destinatários para transmissão ${broadcastId}.`);
  return { ok: true, message: `Reenviando para ${failedCount} destinatário(s) com falha.` };
}

module.exports = {
  createBroadcast,
  listBroadcasts,
  getBroadcastRecipients,
  startBroadcast,
  cancelBroadcast,
  deleteBroadcast,
  retryFailedRecipients,
  getBroadcastAudience,
  getBroadcastStats
};