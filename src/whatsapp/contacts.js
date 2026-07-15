// contacts.js — Auto-registro de contatos a partir de mensagens do WhatsApp.
//
// Extraído de src/config/whatsapp.js (arquivo estava com 747 linhas) para
// reduzir o tamanho do módulo de conexão, seguindo o mesmo padrão já usado
// para lid-map.js e message-utils.js. Nenhuma mudança de comportamento —
// mesma função, movida para cá.

const logger        = require("../utils/logger");
const pool          = require("../database/postgres");
const { emitEvent } = require("../services/socket.service");
const { resolveJidToLid } = require("./lid-map");

async function autoRegisterContact(userId, contactName = "") {
  const rawUserId = String(userId || "").trim();
  const isPhoneJid = rawUserId.endsWith("@s.whatsapp.net");
  const isLidJid = rawUserId.endsWith("@lid");
  if (!isPhoneJid && !isLidJid) return null;

  // Para @lid sem resolução, salvamos o identificador numérico do LID.
  // Isso evita perda de rastreio no painel até que o mapa LID→JID seja descoberto.
  const phone = rawUserId.replace(/@(s\.whatsapp\.net|lid)$/i, "").replace(/\D/g, "");
  if (!phone) return null;

  const safeName = String(contactName || "").trim() || phone;

  // BUG CORRIGIDO: quando este cliente chegou antes via "@lid" SEM
  // resolução (LID_FALLBACK em src/config/whatsapp.js), salvamos ali o
  // identificador NUMÉRICO do próprio lid como telefone provisório — não é
  // o número real. Quando o mesmo cliente resolve depois (mensagem nova já
  // chega como "@s.whatsapp.net", ou o mapa lid→jid é aprendido via
  // sincronização de contatos), essa chamada aqui usa o número real e cria
  // um SEGUNDO registro de contato pro mesmo cliente. Se já sabemos o lid
  // equivalente a este jid, localizamos o registro antigo pra migrar em
  // vez de duplicar.
  let phoneProvisorio = null;
  if (isPhoneJid) {
    const lidEquivalente = resolveJidToLid(rawUserId);
    if (lidEquivalente) {
      phoneProvisorio = lidEquivalente.replace(/@lid$/i, "").replace(/\D/g, "") || null;
    }
  }

  try {
    const existing = await pool.query(
      `SELECT id, nome FROM contacts WHERE whatsapp = $1::varchar LIMIT 1`,
      [phone]
    );

    if (existing.rows.length) {
      const currentName = String(existing.rows[0].nome || "").trim();
      const looksGeneric = !currentName || currentName === phone || /^\d{8,15}$/.test(currentName);

      if (safeName !== phone && looksGeneric) {
        await pool.query(
          `UPDATE contacts SET nome = $1::text, updated_at = NOW() WHERE id = $2`,
          [safeName, existing.rows[0].id]
        );
        logger.info(`[CONTACT_UPDATED] ${phone} nome="${safeName}"`);
        emitEvent("contacts_updated", { reason: "auto_contact_update", whatsapp: phone });
      }

      return existing.rows[0].id;
    }

    if (phoneProvisorio) {
      const antigo = await pool.query(
        `SELECT id, nome FROM contacts WHERE whatsapp = $1::varchar LIMIT 1`,
        [phoneProvisorio]
      );

      if (antigo.rows.length) {
        const currentName  = String(antigo.rows[0].nome || "").trim();
        const looksGeneric  = !currentName || currentName === phoneProvisorio || /^\d{8,15}$/.test(currentName);
        const nomeFinal     = (safeName !== phone && looksGeneric) ? safeName : (currentName || safeName);

        await pool.query(
          `UPDATE contacts SET whatsapp = $1::varchar, nome = $2::text, updated_at = NOW() WHERE id = $3`,
          [phone, nomeFinal, antigo.rows[0].id]
        );
        logger.info(`[CONTACT_MERGED] lid=${phoneProvisorio} → jid=${phone} nome="${nomeFinal}"`);
        emitEvent("contacts_updated", { reason: "auto_contact_merge", whatsapp: phone });
        return antigo.rows[0].id;
      }
    }

    const inserted = await pool.query(
      `INSERT INTO contacts (nome, whatsapp, status, tags)
       VALUES ($1::text, $2::varchar, 'ativo', '{}'::text[])
       RETURNING id`,
      [safeName, phone]
    );

    logger.info(`[CONTACT_CREATED] ${phone} nome="${safeName}"`);
    emitEvent("contacts_updated", { reason: "auto_contact", whatsapp: phone });
    return inserted.rows[0]?.id || null;
  } catch (err) {
    logger.warn(`[AutoContact] falhou para ${phone}: ${err.message}`);
    return null;
  }
}

module.exports = { autoRegisterContact };
