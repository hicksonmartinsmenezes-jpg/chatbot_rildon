const pool = require("../database/postgres");
const logger = require("../utils/logger");
const {
  sendMessage,
  sendMedia
} = require("../config/whatsapp");

const path = require("path");

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

async function listBroadcasts() {
  const res = await pool.query(
    `
    SELECT *
    FROM broadcasts
    ORDER BY created_at DESC
    LIMIT 100
    `
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
  const broadcastRes = await pool.query(
    `SELECT * FROM broadcasts WHERE id = $1`,
    [broadcastId]
  );

  const broadcast = broadcastRes.rows[0];

  if (!broadcast) {
    throw new Error("Transmissão não encontrada.");
  }

  if (broadcast.status === "sending") {
    throw new Error("Esta transmissão já está em andamento.");
  }

  if (broadcast.status === "finished") {
    throw new Error("Esta transmissão já foi finalizada.");
  }

  await pool.query(
    `
    UPDATE broadcasts
    SET status = 'sending', started_at = NOW()
    WHERE id = $1
    `,
    [broadcastId]
  );

  processBroadcastQueue(broadcastId).catch(err => {
    logger.error(`[Broadcast] Erro geral: ${err.message}`);
  });

  return { ok: true, message: "Transmissão iniciada." };
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
    try {
     if (broadcast.image_url) {

  const imagePath = path.join(
    __dirname,
    "..",
    broadcast.image_url
  );

  await sendMedia(
    recipient.user_id,
    imagePath,
    broadcast.message
  );

} else {

  await sendMessage(
    recipient.user_id,
    broadcast.message
  );

}

      await pool.query(
        `
        UPDATE broadcast_recipients
        SET status = 'sent', sent_at = NOW(), error = NULL
        WHERE id = $1
        `,
        [recipient.id]
      );

      sentCount++;

      await pool.query(
        `
        UPDATE broadcasts
        SET sent_count = $1, failed_count = $2
        WHERE id = $3
        `,
        [sentCount, failedCount, broadcastId]
      );

      await sleep(5000);
    } catch (err) {
      failedCount++;

      await pool.query(
        `
        UPDATE broadcast_recipients
        SET status = 'failed', error = $1
        WHERE id = $2
        `,
        [err.message, recipient.id]
      );

      await pool.query(
        `
        UPDATE broadcasts
        SET sent_count = $1, failed_count = $2
        WHERE id = $3
        `,
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

  logger.success(`[Broadcast] Transmissão ${broadcastId} finalizada.`);
}


async function getBroadcastAudience(type) {
  let query = "";

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

  if (!query) {
    throw new Error("Tipo de público inválido.");
  }

  const res = await pool.query(query);

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

module.exports = {
  createBroadcast,
  listBroadcasts,
  getBroadcastRecipients,
  startBroadcast,
  getBroadcastAudience,
  getBroadcastStats
};