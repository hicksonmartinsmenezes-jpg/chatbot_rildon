// dedup.js — Deduplicação de mensagens recebidas via WhatsApp.
//
// Extraído de src/config/whatsapp.js (arquivo estava com 747 linhas) para
// reduzir o tamanho do módulo de conexão, seguindo o mesmo padrão já usado
// para lid-map.js e message-utils.js. Nenhuma mudança de comportamento —
// só as mesmas funções, movidas para cá.
//
// Duas camadas:
// 1. Set em memória (rápido, válido por alguns minutos) — processedMessages.
// 2. Tabela `processed_messages` no banco (persiste entre reinicializações).
//    Se o banco falhar, a camada de memória ainda protege contra duplicatas
//    na mesma sessão.
// 3. Dedup secundário por conteúdo (recentContent) — captura duplicatas de
//    @lid com IDs diferentes que o Baileys entrega na mesma janela de tempo.

const logger = require("../utils/logger");
const pool   = require("../database/postgres");

// Map com TTL por entrada: evita clear abrupto que abriria janela de duplicatas
const processedMessages = new Map(); // id → timestamp
const PROCESSED_TTL_MS  = 5 * 60 * 1000; // 5 min
const PROCESSED_MAX     = 10_000;

// Dedup secundário por conteúdo
const recentContent = new Map(); // `userId:text` → timestamp

// BUG REAL (achado em teste ao vivo, 2026-07-20): esse dedup usa a chave
// `userId:text` — um cliente que responde "2" pra uma pergunta e, poucos
// segundos depois, "2" de novo pra uma pergunta DIFERENTE (ex: abre o
// submenu de crediário com "2", depois escolhe uma opção "2" dentro dele —
// um padrão normalíssimo de navegação por menu numerado, ou simplesmente
// confirmar "sim" duas vezes em pontos diferentes da conversa) tinha a
// segunda mensagem completamente ignorada: sem resposta, sem fallback,
// cliente achando que o bot travou. Reproduzido ao vivo: "2" (abre
// Crediário) seguido de "2" (Consultar situação) — a segunda simplesmente
// não teve resposta alguma.
//
// Uma duplicata REAL do Baileys (mesmo texto, IDs @lid diferentes) chega
// quase instantaneamente — mesmo lote de messages.upsert ou milissegundos
// depois — nunca precisou de uma janela de 8s pra ser capturada. Reduzida
// pra 2s, e respostas curtas (dígitos de menu, "sim", "0", "menu" etc. —
// exatamente as mais prováveis de se repetir legitimamente em pouco tempo)
// ficam de fora deste dedup por conteúdo. A dedup por ID de mensagem
// (marcarMensagemProcessada, camada primária, já aplicada antes desta)
// continua cobrindo o caso comum de duplicata real do Baileys.
const CONTENT_TTL_MS = 2_000; // 2 segundos
const MIN_LEN_DEDUP_CONTEUDO = 10; // abaixo disso, não aplica este dedup

function isDuplicateContent(userId, text) {
  if (!text || text.trim().length < MIN_LEN_DEDUP_CONTEUDO) return false;

  const key = `${userId}:${text}`;
  const ts  = recentContent.get(key);
  if (ts && Date.now() - ts < CONTENT_TTL_MS) return true;
  recentContent.set(key, Date.now());
  // Limpeza incremental
  if (recentContent.size > 500) {
    const cutoff = Date.now() - CONTENT_TTL_MS;
    for (const [k, t] of recentContent) {
      if (t < cutoff) recentContent.delete(k);
    }
  }
  return false;
}

function markProcessed(id) {
  processedMessages.set(id, Date.now());
  // Limpeza incremental: remove entradas expiradas quando mapa fica grande
  if (processedMessages.size > PROCESSED_MAX) {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    for (const [msgId, ts] of processedMessages) {
      if (ts < cutoff) processedMessages.delete(msgId);
    }
  }
}

function isProcessed(id) {
  const ts = processedMessages.get(id);
  if (!ts) return false;
  if (Date.now() - ts > PROCESSED_TTL_MS) {
    processedMessages.delete(id);
    return false;
  }
  return true;
}

/**
 * MELHORIA: deduplicação com duas camadas.
 * 1. Set em memória (rápido, válido por 5 min).
 * 2. Tabela `processed_messages` no banco (persiste entre reinicializações).
 *    Se o banco falhar, a camada de memória ainda protege contra duplicatas
 *    na mesma sessão.
 */
async function marcarMensagemProcessada(messageId) {
  if (!messageId) return false;

  // Camada 1: memória
  if (isProcessed(messageId)) return true;

  // Camada 2: banco
  try {
    const res = await pool.query(
      `INSERT INTO processed_messages (message_id, processed_at)
       VALUES ($1, NOW())
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [messageId]
    );
    // Se nenhuma linha foi inserida → já existia → duplicata
    if (res.rowCount === 0) {
      markProcessed(messageId);
      return true;
    }
  } catch (err) {
    logger.warn(`[Dedup] Erro ao checar banco: ${err.message}`);
  }

  markProcessed(messageId);
  return false;
}

// Limpeza periódica da tabela de dedup (mensagens processadas há mais de 7 dias)
function startDedupCleanup() {
  // .unref() — não deve impedir o processo de encerrar (graceful shutdown/testes).
  // startDedupCleanup() roda no top-level de whatsapp.js, então sem isso
  // qualquer coisa que só requira aquele módulo (incluindo testes) travava.
  setInterval(async () => {
    try {
      await pool.query(`
        DELETE FROM processed_messages
        WHERE processed_at < NOW() - INTERVAL '7 days'
      `);
    } catch (err) {
      logger.warn(`Erro limpando dedup: ${err.message}`);
    }
  }, 24 * 60 * 60 * 1000).unref();
}

module.exports = {
  isDuplicateContent,
  marcarMensagemProcessada,
  startDedupCleanup
};
