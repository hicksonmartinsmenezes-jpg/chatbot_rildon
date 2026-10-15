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

// 2026-10-09 (auditoria de performance): esta função é chamada EM LOOP por
// processContacts, e o WhatsApp manda a lista INTEIRA de contatos a cada
// conexão/reconexão. Com 2.000 contatos, a versão anterior disparava até
// 2.000 `pool.query` simultâneas (num pool de 20!) e 2.000 `logger.info`
// síncronos — era o segundo maior travamento do event loop e a origem direta
// do "[authSession] Connection terminated due to connection timeout": o
// authSession do painel entrava na fila atrás de 2.000 INSERTs de lid_map.
//
// Agora o chamador em lote passa { persist: false } e usa persistLidMappings()
// no fim, que grava tudo em poucos UPSERTs. Chamadas avulsas (uma mensagem
// nova trazendo um LID desconhecido) continuam persistindo na hora, como antes.
//
// Retorna `true` quando o mapeamento MUDOU (pra o chamador em lote saber o que
// precisa gravar); antes não retornava nada.
function setLidMapping(lid, jid, source = "", { persist = true, log = true } = {}) {
  if (!lid || !jid) return false;

  const lidKey = normalizeJid(lid);
  const jidKey = normalizeJid(jid);

  if (!lidKey.endsWith("@lid") || !jidKey.endsWith("@s.whatsapp.net")) return false;

  const changed = lidToJid[lidKey] !== jidKey;
  lidToJid[lidKey] = jidKey;
  jidToLid[jidKey] = lidKey;

  if (!changed) return false;

  if (log) logger.info(`[lidToJid] ${lidKey} → ${jidKey}${source ? ` (via ${source})` : ""}`);

  if (persist) {
    pool.query(
      `INSERT INTO lid_map (lid, jid, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (lid) DO UPDATE SET jid = EXCLUDED.jid, updated_at = NOW()`,
      [lidKey, jidKey]
    ).catch(err => logger.warn(`[lidToJid] persistência falhou: ${err.message}`));
  }

  return true;
}

// Grava vários mapeamentos em poucos UPSERTs, em vez de um por contato.
// Usado por processContacts (config/whatsapp.js) no processamento em lote da
// lista de contatos. Aguarda cada lote — assim o pool nunca recebe mais de uma
// query nossa por vez e o resto do sistema continua conseguindo conexão.
async function persistLidMappings(pares) {
  if (!Array.isArray(pares) || !pares.length) return;

  const TAM_LOTE = 500;
  for (let i = 0; i < pares.length; i += TAM_LOTE) {
    const fatia = pares.slice(i, i + TAM_LOTE);
    const valores = fatia.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2}, NOW())`).join(", ");
    const params  = fatia.flatMap(([l, j]) => [l, j]);

    try {
      await pool.query(
        `INSERT INTO lid_map (lid, jid, updated_at) VALUES ${valores}
         ON CONFLICT (lid) DO UPDATE SET jid = EXCLUDED.jid, updated_at = NOW()`,
        params
      );
    } catch (err) {
      logger.warn(`[lidToJid] persistência em lote falhou (${fatia.length} itens): ${err.message}`);
    }
  }
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

// Forma canônica de um userId pra fins de EXIBIÇÃO/agrupamento (painel): se
// for um @lid com jid já conhecido, devolve o jid — senão devolve o próprio
// valor, SEM passar por normalizeJid. Isso é deliberado: normalizeJid extrai
// dígitos e monta "...@s.whatsapp.net" mesmo de strings que não são um id de
// WhatsApp de verdade (ex: ids de teste como "u1" virariam "1@s.whatsapp.net"),
// o que é o comportamento certo pra normalizar entrada de usuário, mas errado
// aqui — canonicalizeUserId só deve mexer no caso específico que causa o bug
// (o mesmo cliente com user_id salvo ora como "...@lid", ora já resolvido
// pra "...@s.whatsapp.net" — ver LID_FALLBACK em config/whatsapp.js) e deixar
// qualquer outro valor intocado. Usado pra alinhar a chave usada por
// getConversationsHandler com a usada por getTickets, que é o que o
// frontend cruza em ticketsByUser[userId].
function canonicalizeUserId(userId) {
  const raw = String(userId || "").trim();
  if (raw.endsWith("@lid")) {
    return resolveLid(raw) || raw;
  }
  return raw;
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
  persistLidMappings,
  carregarLidMap,
  resolveLid,
  resolveJidToLid,
  resolveSendJid,
  getProfilePhotoCandidates,
  canonicalizeUserId,
  getLidMapStats
};
