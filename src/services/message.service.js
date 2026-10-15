const mainFlow        = require("../flows/main.flow");
const { saveHistory } = require("./history.service");
const { enqueue }     = require("./queue.service");
const { getSession }  = require("./session.service");
const { getBotConfig, resolverBotOffEfetivo } = require("./botConfig.service");
const { emitEvent }   = require("./socket.service");
const { reopenTicketIfClosed, handleSatisfactionReply, pareceEncerramentoPosAvaliacao, garantirTicketPendente } = require("./ticket.service");
const humanMode       = require("./humanMode.service");
const logger          = require("../utils/logger");

const BOT_FLOW_FALLBACK =
  process.env.BOT_FLOW_FALLBACK ||
  "⚠️ Não consegui processar sua solicitação agora. Tente novamente em instantes ou aguarde um atendente.";

// ─── Rate Limiting ───────────────────────────────────────────────────────────
//
// MELHORIA: o objeto rateLimits era persistido em memória global, o que significa:
//   1. Perde os contadores em cada restart do processo.
//   2. Em múltiplas instâncias (Docker Swarm, PM2 cluster), cada processo tem
//      seu próprio contador — o limite real efetivo é N×RATE_MAX.
//
// Solução aplicada: abstração RateLimiter com implementação em memória padrão,
// pronta para ser trocada por Redis sem alterar o restante do código.
// Para ativar Redis, basta criar src/services/rateLimiter.redis.js e importar aqui.
//
// Estrutura da abstração:
//   - hit(userId): registra uma requisição, retorna true se ainda dentro do limite
//   - cleanup():   remove entradas antigas (chamado periodicamente)
// ─────────────────────────────────────────────────────────────────────────────

const RATE_MAX    = parseInt(process.env.RATE_LIMIT_MAX        || "10");
const RATE_JANELA = parseInt(process.env.RATE_LIMIT_JANELA_MS  || "10000");

class MemoryRateLimiter {
  constructor() {
    this._store = {};

    // Limpeza periódica: remove entradas inativas há mais de 1 hora
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  hit(userId) {
    const agora = Date.now();

    if (!this._store[userId]) {
      this._store[userId] = { count: 0, inicio: agora };
    }

    const r = this._store[userId];

    if (agora - r.inicio > RATE_JANELA) {
      r.count = 0;
      r.inicio = agora;
    }

    r.count++;
    return r.count <= RATE_MAX;
  }

  cleanup() {
    const agora    = Date.now();
    const UMA_HORA = 60 * 60 * 1000;

    for (const userId of Object.keys(this._store)) {
      if (agora - this._store[userId].inicio > UMA_HORA) {
        delete this._store[userId];
      }
    }
  }
}

const rateLimiter = new MemoryRateLimiter();

// ─── Processamento ───────────────────────────────────────────────────────────
// mediaPath/mediaMimetype/mediaFilename (ver migration 017): repassados por
// config/whatsapp.js quando a mensagem recebida tinha foto/áudio/vídeo/
// sticker/documento — já baixados e salvos em disco lá, aqui só precisam
// ser gravados junto com a linha de histórico correspondente.
async function processMessage({ userId, contactName, message, messageId, mediaPath, mediaMimetype, mediaFilename, isNumeroTeste = false, isFuncionario = false }) {
  const botConfig = await getBotConfig();

  // BUG CORRIGIDO: esse "bot desligado" curto-circuitava a função inteira
  // logo aqui no topo — ANTES até do reopenTicketIfClosed e do emit de
  // "nova_mensagem" mais abaixo. Ou seja, com o bot desligado no painel
  // (Configurações > Funcionamento > Bot ativo = Desativado), a mensagem do
  // cliente nunca era salva no histórico nem emitida pro painel: sumia por
  // completo, sem notificação nem card na conversa. Reportado pelo usuário:
  // "quando desligado, as mensagens e notificações novas simplesmente não
  // aparecem". Agora `botOff` só impede RESPOSTA automática (rate limiter,
  // fluxo do bot) — a mensagem em si sempre é registrada e aparece no
  // painel normalmente, igual ao modo humano (ver gate combinado com
  // humanMode.estaAtivo() logo abaixo). A pesquisa de satisfação é uma
  // exceção deliberada — ver comentário abaixo.
  //
  // MODO DE TESTE + BLOQUEIO "FUNCIONÁRIO" (pedido do usuário, 2026-07-24):
  // `isNumeroTeste`/`isFuncionario` chegam já resolvidos por config/whatsapp.js
  // (onMessagesUpsert) — re-aplicamos a MESMA regra de prioridade aqui via
  // resolverBotOffEfetivo() (fonte única em botConfig.service.js) porque é
  // só AQUI, dentro do enqueue mais abaixo, que mainFlow (IA/ERP) de fato
  // roda. O botConfig é buscado de novo (linha acima) em vez de reaproveitar
  // o de config/whatsapp.js de propósito — mensagens fragmentadas podem
  // demorar alguns segundos até chegar aqui, e o ativo/desativado do painel
  // pode ter mudado nesse meio-tempo.
  const botOff = resolverBotOffEfetivo({
    ativoFalse: botConfig.ativo === false || botConfig.ativo === "false",
    isNumeroTeste,
    isFuncionario,
  });

  if (!botOff && !rateLimiter.hit(userId)) {
    logger.warn(`Rate limit atingido para ${userId}`);
    return "⚠️ Muitas mensagens em pouco tempo. Aguarde alguns segundos e tente novamente.";
  }

  // Pesquisa de satisfação pendente (ver ticket.service.js)? Precisa vir
  // ANTES de reopenTicketIfClosed — senão a própria resposta da pesquisa
  // (ex: cliente manda "5") reabriria o ticket fechado como se fosse um
  // pedido novo, em vez de só registrar a nota.
  //
  // PEDIDO DO USUÁRIO (2026-07-23): roda mesmo com o bot desligado
  // (`botOff`) — antes disso, um ticket fechado que já tinha disparado a
  // pesquisa ficava "mudo" quando o bot era desligado logo depois: o
  // cliente respondia a nota (ex: "5") e nada acontecia, sem agradecimento
  // nem registro da avaliação. Isso é seguro porque handleSatisfactionReply
  // não é "o bot iniciando atendimento novo" — só fecha o laço de uma
  // pesquisa que o próprio bot já tinha enviado ANTES de ser desligado, e só
  // dispara dentro de uma janela curta (SATISFACTION_WINDOW_MS) com uma flag
  // de sessão (aguardandoNotaSatisfacao/aguardandoFeedbackSatisfacao) setada
  // no instante exato do envio da pesquisa — não tem como "vazar" e virar
  // resposta automática de um assunto novo. Mesmo comportamento já valia
  // pra humanMode ativo (nunca teve gate aqui pra isso, só o de botOff).
  let pesquisa = null;
  try {
    pesquisa = await handleSatisfactionReply({ userId, message });
  } catch (e) {
    logger.warn(`Erro ao checar pesquisa de satisfação: ${e.message}`);
  }
  if (pesquisa) {
    try {
      emitEvent("nova_mensagem", {
        userId,
        contactName,
        message,
        messageId,
        response: pesquisa.response,
        sector: "pesquisa_satisfacao",
        createdAt: new Date(),
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (e) { logger.warn(`Erro ao emitir nova_mensagem (pesquisa): ${e.message}`); }

    try {
      await saveHistory({
        userId,
        contactName,
        message,
        messageId,
        response: pesquisa.response,
        sector: "pesquisa_satisfacao",
        status: "sent",
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (err) {
      logger.warn(`Erro ao salvar histórico (pesquisa de satisfação): ${err.message}`);
    }

    return pesquisa.response;
  }

  // BUG REAL (relatado pelo usuário, teste ao vivo 2026-07-27): cliente
  // avaliou o atendimento, foi agradecido, e minutos depois mandou só "👍" —
  // o bot reabria o ticket e tentava responder como pergunta nova (nesse
  // caso a IA falhou e devolveu o menu inteiro, uma resposta estranha pra
  // uma reação de despedida). Em vez de atrasar o bot genericamente pra
  // TODO mundo depois de fechar (arriscando ignorar quem manda uma dúvida
  // nova de verdade logo em seguida), verifica especificamente se ESTA
  // mensagem é só um agradecimento/reação — ver pareceEncerramentoPosAvaliacao
  // em ticket.service.js. Se for, não reabre o ticket nem aciona o bot,
  // só registra no histórico.
  let encerramento = false;
  try {
    encerramento = await pareceEncerramentoPosAvaliacao(userId, message);
  } catch (e) {
    logger.warn(`Erro ao checar encerramento pós-avaliação: ${e.message}`);
  }
  if (encerramento) {
    try {
      await saveHistory({
        userId, contactName, message, messageId, response: null,
        sector: "encerramento_pos_avaliacao",
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (err) {
      logger.warn(`Erro ao salvar histórico (encerramento pós-avaliação): ${err.message}`);
    }
    try {
      emitEvent("nova_mensagem", {
        userId, contactName, message, messageId, response: null,
        sector: "encerramento_pos_avaliacao", createdAt: new Date(),
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (e) { logger.warn(`Erro ao emitir nova_mensagem (encerramento pós-avaliação): ${e.message}`); }
    return "";
  }

  // Reabre ticket fechado para que o cliente apareça em Pendentes novamente
  //
  // BUG CORRIGIDO (pedido do usuário, 2026-07-31): esta chamada rodava
  // incondicionalmente, ANTES do gate de isFuncionario mais abaixo — então
  // um contato com a tag "Funcionário" (número de teste interno, ver
  // contatoTemTagFuncionario/resolverBotOffEfetivo) que tivesse um ticket
  // antigo fechado tinha esse ticket REABERTO (virava "aberto", aparecia em
  // Pendentes de novo) só por mandar qualquer mensagem — mesmo com o bot
  // bloqueado pra ele. O bloqueio de tag "Funcionário" (2026-07-24) só
  // cobria resposta automática/saudação/pesquisa; reabertura de ticket
  // escapava por rodar cedo demais nesta função. Isso é, na prática, o bot
  // recriando/reativando atendimento pra número de teste — o mesmo problema
  // que o usuário pediu pra evitar.
  if (!isFuncionario) {
    try { await reopenTicketIfClosed(userId); } catch (e) { logger.warn(`Erro ao reabrir ticket: ${e.message}`); }
  }

  // Emite imediatamente para o frontend saber que o cliente mandou mensagem.
  // messageId (id real da mensagem no WhatsApp) é incluído para o painel
  // deduplicar por id exato em vez de um fallback frágil por timestamp —
  // ver BUG CORRIGIDO abaixo, no segundo emit.
  try {
    emitEvent("nova_mensagem", {
      userId,
      contactName,
      message,
      messageId,
      response: null,
      sector: null,
      createdAt: new Date(),
      mediaPath, mediaMimetype, mediaFilename
    });
  } catch (e) { logger.warn(`Erro ao emitir nova_mensagem: ${e.message}`); }

  // ── Bot desligado no painel OU atendente assumiu → sem resposta automática ──
  // A mensagem do cliente já foi emitida ao painel acima (reopen + emit
  // sempre rodam, bot ligado ou não — ver nota no início da função); aqui só
  // persistimos o histórico e NÃO acionamos o fluxo do bot.
  if (botOff || humanMode.estaAtivo(userId)) {
    // Sector distinto para contato bloqueado por tag "Funcionário" — ajuda a
    // diferenciar no painel/histórico de um "bot desligado" normal ou de um
    // atendimento humano de verdade (ver resolverBotOffEfetivo acima).
    const sector = isFuncionario ? "funcionario_bloqueado" : (botOff ? "bot_desligado" : "humano");
    // Bot desligado + cliente de verdade (não "Funcionário"): garante um ticket
    // pendente para o atendimento aparecer no painel/Dashboard (ver
    // garantirTicketPendente em ticket.service.js). Best-effort.
    if (botOff && !isFuncionario) {
      try {
        await garantirTicketPendente({ userId, customerName: contactName, message });
      } catch (err) {
        logger.warn(`Erro ao garantir ticket com bot desligado: ${err.message}`);
      }
    }
    try {
      await saveHistory({
        userId, contactName, message, messageId, response: null,
        sector,
        mediaPath, mediaMimetype, mediaFilename
      });
    } catch (err) {
      logger.warn(`Erro ao salvar histórico (${sector}): ${err.message}`);
    }
    return "";
  }

  return enqueue(userId, async () => {
    const session = getSession(userId) || {};
    const sector = session.sector || "main";
    let response;
    let flowError = null;

    try {
      // Log de recebimento já feito em whatsapp.js (ponto de entrada) — evita linha duplicada
      response = await mainFlow({ userId, message });
    } catch (err) {
      flowError = err;
      response = BOT_FLOW_FALLBACK;
      logger.error(`[FLOW_ERROR] ${userId}: ${err.stack || err.message}`);
    }

    if (!response) {
      logger.warn(`Fluxo sem resposta para ${userId}`);
      return "";
    }

    // BUG CORRIGIDO: o check de humanMode.estaAtivo() lá no topo desta função
    // (antes do enqueue) só protege contra mensagens que chegam DEPOIS do
    // atendente assumir. Mas mainFlow() acima pode levar vários segundos
    // (chamadas de IA), e se o atendente assumir o ticket ENQUANTO essa
    // mensagem específica já estava em processamento, o check antigo já tinha
    // passado — o bot respondia por cima do atendente segundos depois dele já
    // ter assumido. Reproduzido em produção (ticket #2026-0090, 2026-07-23):
    // atendente assumiu e mandou saudação às 14:08:10.667, e a resposta do bot
    // pra uma mensagem que já estava em processamento saiu às 14:08:12.941 —
    // ~2.3s depois, ignorando completamente o atendente. Re-checar aqui, logo
    // que a resposta do fluxo já está pronta (mas antes de salvar/emitir/
    // enviar), fecha essa janela de corrida.
    if (humanMode.estaAtivo(userId)) {
      logger.info(`[humanMode] Resposta do bot descartada para ${userId} — atendente assumiu durante o processamento da mensagem.`);
      try {
        await saveHistory({
          userId, contactName, message, messageId, response: null, sector: "humano",
          mediaPath, mediaMimetype, mediaFilename
        });
      } catch (err) {
        logger.warn(`Erro ao salvar histórico (modo humano, pós-processamento): ${err.message}`);
      }
      return "";
    }

    try {
      await saveHistory({
        userId,
        contactName,
        message,
        messageId,
        response,
        sector: flowError ? "erro" : sector,
        mediaPath, mediaMimetype, mediaFilename
      });

      // Emite de novo com a resposta do bot já salva.
      //
      // BUG CORRIGIDO: esse segundo emit e o primeiro (logo no início da
      // função) representam a MESMA mensagem do cliente em dois momentos
      // (chegada e depois de processada pelo bot/IA). Nenhum dos dois
      // incluía messageId, então o frontend (frontend/js/12-socket.js)
      // caía num fallback de dedup por "mesmo userId + mesmo texto dentro
      // de 3 segundos". Como o processamento do fluxo/IA pode levar mais
      // de 3s (timeout de até 45s, ver MESSAGE_PROCESSING_TIMEOUT_MS em
      // src/config/whatsapp.js), o segundo emit passava a ser tratado como
      // mensagem NOVA pelo painel → 1 mensagem real virava 2 cards na tela
      // (só visual — o banco recebe um único INSERT). Agora os dois emits
      // (e o saveHistory acima) levam o messageId real do WhatsApp
      // (msg.key.id, capturado em onMessagesUpsert), permitindo o frontend
      // deduplicar por id exato, sem depender de janela de tempo.
      try {
        emitEvent("nova_mensagem", {
          userId,
          contactName,
          message,
          messageId,
          response,
          sector: flowError ? "erro" : sector,
          error: flowError ? true : false,
          createdAt: new Date(),
          mediaPath, mediaMimetype, mediaFilename
        });
      } catch (e) { logger.warn(`Erro ao emitir nova_mensagem (resposta): ${e.message}`); }
    } catch (err) {
      logger.error(`Erro ao salvar histórico: ${err.message}`);
    }

    return response;
  });
}

module.exports = { processMessage };
