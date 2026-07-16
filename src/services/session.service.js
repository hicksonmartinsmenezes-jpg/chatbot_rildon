const logger = require("../utils/logger");
const pool = require("../database/postgres");
const { getBotConfig } = require("./botConfig.service");

const sessions = {};
const timers   = {};

const TTL_HORAS = parseInt(process.env.SESSION_TTL_HORAS || "24");

let _sendMessage    = null;
let cleanupStarted  = false;

async function getTimeouts() {
  try {
    const cfg = await getBotConfig();
    return {
      avisoMs:   (cfg.timeoutAviso        || parseInt(process.env.AVISO_MINUTOS   || "3")) * 60_000,
      timeoutMs: (cfg.timeoutEncerramento || parseInt(process.env.TIMEOUT_MINUTOS || "5")) * 60_000
    };
  } catch {
    return {
      avisoMs:   parseInt(process.env.AVISO_MINUTOS   || "3") * 60_000,
      timeoutMs: parseInt(process.env.TIMEOUT_MINUTOS || "5") * 60_000
    };
  }
}

async function setSendMessage(fn) {
  _sendMessage = fn;
  const { avisoMs, timeoutMs } = await getTimeouts();
  logger.info(
    `⏱️ Timeout de inatividade ativo (aviso: ${avisoMs / 60000}min | encerramento: ${timeoutMs / 60000}min)`
  );

  await _carregarSessoes();
  _agendarLimpezaTTL();
}

async function _carregarSessoes() {
  try {
    const res = await pool.query(
      `SELECT user_id, data
       FROM sessions
       WHERE updated_at > NOW() - ($1 * INTERVAL '1 hour')`,
      [TTL_HORAS]
    );

    for (const row of res.rows) {
      sessions[row.user_id] = row.data;
    }

    logger.info(`${res.rowCount} sessão(ões) restauradas do banco`);
  } catch (err) {
    logger.warn(`Não foi possível restaurar sessões: ${err.message}`);
  }
}

function _agendarLimpezaTTL() {
  if (cleanupStarted) return;
  cleanupStarted = true;

  setInterval(async () => {
    try {
      const res = await pool.query(
        `DELETE FROM sessions WHERE updated_at < NOW() - ($1 * INTERVAL '1 hour')`,
        [TTL_HORAS]
      );

      if (res.rowCount > 0) {
        logger.info(`[Sessions] ${res.rowCount} sessão(ões) expirada(s) removida(s)`);
      }
    } catch (err) {
      logger.warn(`[Sessions] Erro na limpeza de TTL: ${err.message}`);
    }
  }, 60 * 60 * 1000).unref();
}

function getSession(userId) {
  return sessions[userId] || { sector: "main" };
}

// skipTimer: true evita (re)agendar os avisos de inatividade ("Ainda está
// aí?" / "Atendimento encerrado por inatividade"). Usado por
// finalizarComTicket() — depois que um ticket é criado, o bot não está mais
// esperando resposta nenhuma do cliente, então esses avisos são confusos
// (relatado pelo usuário: mensagem de "encerrado por inatividade" chegando
// logo após "orçamento registrado", como se o atendimento tivesse sido
// cancelado). A sessão continua existindo normalmente (mantém aiHistorico
// pra perguntas de acompanhamento) — só não dispara os timers de aviso/fim;
// ela é limpa mais tarde pelo TTL padrão (_agendarLimpezaTTL) ou pelo timer
// normal assim que o cliente interagir de novo (updateSession sem
// skipTimer, no fluxo seguinte).
async function updateSession(userId, data, { skipTimer = false } = {}) {
  sessions[userId] = {
    ...getSession(userId),
    ...data
  };

  await _persistirSessao(userId);

  if (skipTimer) {
    cancelTimer(userId);
  } else {
    resetTimer(userId);
  }
}

async function clearSession(userId) {
  cancelTimer(userId);
  delete sessions[userId];
  await _removerSessao(userId);
}

// BUG CORRIGIDO: todo fluxo (vendas/crediário/gestão/atendente) chamava
// clearSession() puro logo após criar o ticket — isso apaga TAMBÉM o
// aiHistorico da conversa com a IA. Resultado: se o cliente manda uma
// pergunta de acompanhamento natural logo em seguida (ex: "Quando?",
// "Quanto tempo demora?"), a IA responde sem NENHUM contexto do ticket
// que acabou de ser criado — vira uma resposta genérica/sem sentido, tipo
// saudação, e ainda reexibe o menu (relatado pelo usuário: pergunta
// "Quando?" depois do orçamento virou "Bom dia! Em que posso te ajudar?").
// finalizarComTicket() faz o mesmo reset de sector/step/dados coletados
// (equivalente ao clearSession para fins de navegação), mas MANTÉM
// aiHistorico e customerName, e ainda acrescenta uma nota sintética do
// que foi registrado — assim uma pergunta de acompanhamento tem contexto
// pra IA responder de forma útil.
async function finalizarComTicket(userId, ticket) {
  const atual = getSession(userId);
  let aiHistorico = atual.aiHistorico || [];

  if (ticket) {
    aiHistorico = [
      ...aiHistorico,
      {
        role: "model",
        parts: [{
          text: `Registrei sua solicitação — protocolo #${ticket.protocolo}. Nosso time entra em contato em breve (geralmente ainda no mesmo dia útil, respeitando o horário de atendimento).`
        }],
      },
    ].slice(-20);
  }

  await updateSession(userId, {
    sector:         undefined,
    step:           undefined,
    veiculo:        undefined,
    cpf:            undefined,
    produtoInicial: undefined,
    // Pedido do usuário: veículo/peça extraídos pela IA na 1ª mensagem (ver
    // main.flow.js/vendas.flow.js) — limpa junto pra não vazar pra uma
    // futura sessão deste mesmo cliente.
    veiculoInicial: undefined,
    pecaInicial:    undefined,
    // Mesma ideia: "sugestões" guardadas quando o cliente só fez uma
    // pergunta de disponibilidade (sem pedidoExplicito) — ver main.flow.js.
    // Limpa aqui também pra não vazar pra uma futura conversa.
    veiculoSugerido: undefined,
    pecaSugerido:    undefined,
    aiHistorico,
  }, { skipTimer: true });
}

async function _persistirSessao(userId) {
  try {
    await pool.query(
      `INSERT INTO sessions (user_id, data, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [userId, JSON.stringify(sessions[userId])]
    );
  } catch (err) {
    logger.warn(`[Sessions] Erro ao persistir sessão ${userId}: ${err.message}`);
  }
}

async function _removerSessao(userId) {
  try {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  } catch (err) {
    logger.warn(`[Sessions] Erro ao remover sessão ${userId}: ${err.message}`);
  }
}

function cancelTimer(userId) {
  if (timers[userId]) {
    clearTimeout(timers[userId].aviso);
    clearTimeout(timers[userId].fim);
    delete timers[userId];
  }
}

async function isBotAtivo() {
  const botConfig = await getBotConfig();
  return !(botConfig.ativo === false || botConfig.ativo === "false");
}

function resetTimer(userId) {
  cancelTimer(userId);

  // CORRIGIDO: bloco de guarda duplicado removido — apenas uma verificação
  getTimeouts().then((timeouts) => {
    const avisoMs = timeouts.avisoMs;
    let timeoutMs = timeouts.timeoutMs;

    if (timeoutMs <= avisoMs) {
      logger.warn(
        "[Session] timeoutEncerramento menor ou igual ao timeoutAviso. Ajustando automaticamente."
      );
      timeoutMs = avisoMs + 60_000;
    }

    const aviso = setTimeout(async () => {
      if (!_sendMessage || !sessions[userId]) return;

      try {
        if (!(await isBotAtivo())) {
          logger.warn("Bot desativado. Aviso de inatividade ignorado.");
          return;
        }

        await _sendMessage(
          userId,
          `⏳ Ainda está aí? Não recebi resposta nos últimos ${avisoMs / 60000} minutos.\n\nSe precisar de ajuda, é só digitar *0* para voltar ao menu.\n\nVou encerrar o atendimento em mais ${(timeoutMs - avisoMs) / 60000} minuto(s) caso não haja resposta.`
        );
      } catch (err) {
        logger.error("Erro ao enviar aviso de inatividade:", err.message);
      }
    }, avisoMs);

    const fim = setTimeout(async () => {
      if (!_sendMessage || !sessions[userId]) return;

      try {
        if (!(await isBotAtivo())) {
          logger.warn("Bot desativado. Encerramento por inatividade ignorado.");
          return;
        }

        await _sendMessage(
          userId,
          "👋 Atendimento encerrado por inatividade.\n\nQuando quiser, é só mandar uma mensagem que estaremos aqui! 😊"
        );
      } catch (err) {
        logger.error("Erro ao enviar mensagem de encerramento:", err.message);
      } finally {
        await clearSession(userId);
      }
    }, timeoutMs);

    timers[userId] = { aviso, fim };

  }).catch(err => {
    logger.warn(`[Session] Falha ao carregar timeouts: ${err.message}`);
  });
}

module.exports = {
  getSession,
  updateSession,
  clearSession,
  finalizarComTicket,
  setSendMessage
};
