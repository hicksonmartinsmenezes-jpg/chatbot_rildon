const pool = require("../database/postgres");
const logger = require("../utils/logger");

// Mapa LID (@lid) → JID real (@s.whatsapp.net), persistido em PostgreSQL.
// Mantemos também o reverso para envio manual: número → @lid quando existir.
const lidToJid = {};
const jidToLid = {};
let loaded = false;

function normalizeJid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.endsWith("@s.whatsapp.net") || raw.endsWith("@lid") || raw.endsWith("@g.us")) return raw;
  const digits = raw.replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : raw;
}

function setLidMapping(lid, jid, source = "") {
  if (!lid || !jid) return;

  const lidKey = normalizeJid(lid);
  const jidKey = normalizeJid(jid);

  if (!lidKey.endsWith("@lid") || !jidKey.endsWith("@s.whatsapp.net")) return;

  const changed = lidToJid[lidKey] !== jidKey;
  lidToJid[lidKey] = jidKey;
  jidToLid[jidKey] = lidKey;

  if (!changed) return;

  logger.info(`[lidToJid] ${lidKey} → ${jidKey}${source ? ` (via ${source})` : ""}`);

  pool.query(
    `INSERT INTO lid_map (lid, jid, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (lid) DO UPDATE SET jid = EXCLUDED.jid, updated_at = NOW()`,
    [lidKey, jidKey]
  ).catch(err => logger.warn(`[lidToJid] persistência falhou: ${err.message}`));
}

async function carregarLidMap() {
  if (loaded) return;
  loaded = true;

  try {
    const res = await pool.query(`SELECT lid, jid FROM lid_map`);
    for (const row of res.rows) {
      const lid = normalizeJid(row.lid);
      const jid = normalizeJid(row.jid);
      if (!lid || !jid) continue;
      lidToJid[lid] = jid;
      jidToLid[jid] = lid;
    }
    if (res.rowCount) logger.info(`[lidToJid] ${res.rowCount} mapeamento(s) restaurado(s) do banco`);
  } catch (err) {
    logger.warn(`[lidToJid] Falha ao restaurar do banco: ${err.message}`);
  }
}

function resolveLid(lid) {
  return lidToJid[normalizeJid(lid)] || null;
}

function resolveJidToLid(jid) {
  return jidToLid[normalizeJid(jid)] || null;
}

function resolveSendJid(userId) {
  const normalized = normalizeJid(userId);
  return resolveJidToLid(normalized) || normalized;
}

function getProfilePhotoCandidates(userId) {
  const raw = String(userId || "").trim();
  const normalized = normalizeJid(raw);
  const digits = raw.replace(/\D/g, "");
  const phoneJid = digits ? `${digits}@s.whatsapp.net` : "";

  return Array.from(new Set([
    raw,
    normalized,
    phoneJid,
    resolveLid(raw),
    resolveLid(normalized),
    resolveLid(phoneJid),
    resolveJidToLid(raw),
    resolveJidToLid(normalized),
    resolveJidToLid(phoneJid)
  ].filter(Boolean)));
}

function getLidMapStats() {
  return {
    lidToJid: Object.keys(lidToJid).length,
    jidToLid: Object.keys(jidToLid).length
  };
}

module.exports = {
  normalizeJid,
  setLidMapping,
  carregarLidMap,
  resolveLid,
  resolveJidToLid,
  resolveSendJid,
  getProfilePhotoCandidates,
  getLidMapStats
};
