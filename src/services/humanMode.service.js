/**
 * humanMode.service.js
 *
 * Takeover humano: quando um atendente assume uma conversa, o bot é
 * pausado para aquele cliente (não responde automaticamente). O cliente
 * passa a falar só com a pessoa. O bot volta quando o ticket é fechado,
 * por inatividade do atendente, ou via botão "Devolver ao bot".
 *
 * Estado em memória (leitura rápida no pipeline) + persistência no banco
 * (tabela human_mode_sessions) para sobreviver a restarts.
 */

const pool   = require("../database/postgres");
const logger = require("../utils/logger");
const { emitEvent } = require("./socket.service");
const { getProfilePhotoCandidates } = require("../whatsapp/lid-map");

// Inatividade do ATENDENTE que faz o bot voltar sozinho (evita cliente no vácuo)
const TTL_MS = Number(process.env.HUMAN_MODE_TTL_MIN || 30) * 60_000;

// userId → { agentName, ticketId, protocolo, since, lastActivity } (ms)
const _cache = new Map();

// BUG CORRIGIDO: todo o módulo indexava sessões de atendimento humano pelo
// userId cru, sem normalização. O WhatsApp entrega mensagens do mesmo
// cliente ora como "...@lid" ora já resolvidas para "...@s.whatsapp.net"
// (ver LID_FALLBACK em src/config/whatsapp.js) — se o atendente assumisse
// sob um formato e a próxima mensagem do cliente chegasse resolvida no
// outro, estaAtivo() não achava a sessão: o bot voltava a responder
// sozinho mesmo com o atendente já atendendo (ou, na direção oposta,
// ativar() criava uma SEGUNDA entrada pro mesmo cliente em vez de renovar
// a existente). _findExistingKey() acha a chave já em uso pra esse
// cliente, em qualquer formato equivalente conhecido (lid ↔ jid).
function _findExistingKey(userId) {
  if (_cache.has(userId)) return userId;
  for (const candidato of getProfilePhotoCandidates(userId)) {
    if (_cache.has(candidato)) return candidato;
  }
  return null;
}

async function carregar() {
  try {
    const res = await pool.query(
      `SELECT user_id, ticket_id, ticket_protocolo, agent_name,
              EXTRACT(EPOCH FROM since)*1000         AS since_ms,
              EXTRACT(EPOCH FROM last_activity)*1000 AS last_ms
       FROM human_mode_sessions`
    );
    for (const r of res.rows) {
      _cache.set(r.user_id, {
        agentName:    r.agent_name || "",
        ticketId:     r.ticket_id,
        protocolo:    r.ticket_protocolo,
        since:        Number(r.since_ms) || Date.now(),
        lastActivity: Number(r.last_ms)  || Date.now(),
      });
    }
    if (res.rowCount) logger.info(`[humanMode] ${res.rowCount} sessão(ões) de atendimento humano restauradas`);
  } catch (err) {
    logger.warn(`[humanMode] Falha ao restaurar sessões: ${err.message}`);
  }
}

function _persistir(userId) {
  const s = _cache.get(userId);
  if (!s) return;
  pool.query(
    `INSERT INTO human_mode_sessions (user_id, ticket_id, ticket_protocolo, agent_name, since, last_activity)
     VALUES ($1,$2,$3,$4, to_timestamp($5/1000.0), to_timestamp($6/1000.0))
     ON CONFLICT (user_id) DO UPDATE SET
       ticket_id        = EXCLUDED.ticket_id,
       ticket_protocolo = EXCLUDED.ticket_protocolo,
       agent_name       = EXCLUDED.agent_name,
       last_activity    = EXCLUDED.last_activity`,
    [userId, s.ticketId ?? null, s.protocolo ?? null, s.agentName || "", s.since, s.lastActivity]
  ).catch(err => logger.warn(`[humanMode] persistência falhou: ${err.message}`));
}

/** O bot deve ficar em silêncio para este usuário? */
function estaAtivo(userId) {
  const key = _findExistingKey(userId);
  if (!key) return false;
  const s = _cache.get(key);
  if (Date.now() - s.lastActivity > TTL_MS) {
    desativar(key, "inatividade");
    return false;
  }
  return true;
}

/** Ativa (ou renova) o atendimento humano para um usuário. */
function ativar(userId, { agentName, ticketId, protocolo } = {}) {
  if (!userId) return;
  const now = Date.now();
  // Renova a sessão já existente pra esse cliente (em qualquer formato
  // equivalente conhecido) em vez de criar uma segunda entrada — ver nota
  // em _findExistingKey acima.
  const key  = _findExistingKey(userId) || userId;
  const prev = _cache.get(key);
  _cache.set(key, {
    agentName:    agentName ?? prev?.agentName ?? "",
    ticketId:     ticketId  ?? prev?.ticketId,
    protocolo:    protocolo ?? prev?.protocolo,
    since:        prev?.since || now,
    lastActivity: now,
  });
  _persistir(key);

  // BUG CORRIGIDO: nenhum evento de socket era emitido ao ativar/desativar o
  // atendimento humano — outras abas/atendentes conectados só percebiam a
  // mudança 30s depois (polling) ou nunca, se estivessem numa conversa
  // diferente. Reportado pelo usuário: ações de assumir/transferir/fechar/
  // devolver ao bot "não atualizavam" — o autor da ação via sucesso na
  // própria aba, mas outras sessões abertas (ex: painel admin observando)
  // ficavam com o estado antigo.
  //
  // BUG CORRIGIDO (2): a 1ª versão emitia isso incondicionalmente, mas
  // ativar() é chamado em TODA mensagem manual enviada pelo atendente
  // (sendManualMessage → humanMode.ativar()), não só na 1ª vez — então
  // cada mensagem trocada disparava um broadcast de socket a mais pra
  // TODOS os painéis conectados, cada um reagindo com fetches extras
  // (openConversation + reload da lista). Numa conversa ativa isso vira
  // uma enxurrada de requisições — contribuiu direto pro rate limit
  // "muitas requisições" e pra lentidão/instabilidade relatada. Só emite
  // quando é uma ativação de verdade (!prev), igual ao log logo abaixo.
  if (!prev) {
    logger.info(`[humanMode] Bot pausado para ${key}${agentName ? ` (atendente: ${agentName})` : ""}`);
    emitEvent("humanmode_atualizado", { userId: key, active: true, agentName: agentName ?? "" });
  }
}

/** Renova a atividade do atendente (mantém o bot pausado). */
function renovar(userId) {
  const key = _findExistingKey(userId);
  if (key) ativar(key);
}

/** Desativa — o bot volta a responder. */
function desativar(userId, motivo = "manual") {
  const key = _findExistingKey(userId);
  if (!key) return;
  _cache.delete(key);
  logger.info(`[humanMode] Bot reativado para ${key} (motivo: ${motivo})`);
  pool.query(`DELETE FROM human_mode_sessions WHERE user_id = $1`, [key])
    .catch(err => logger.warn(`[humanMode] erro ao remover sessão: ${err.message}`));

  // Ver nota em ativar() — mantém todas as sessões do painel em sincronia.
  emitEvent("humanmode_atualizado", { userId: key, active: false, motivo });
}

/** Lista os userIds em atendimento humano (para o painel). */
function listar() {
  const ativos = [];
  for (const [userId] of _cache) if (estaAtivo(userId)) ativos.push(userId);
  return ativos;
}

module.exports = { carregar, estaAtivo, ativar, renovar, desativar, listar };
