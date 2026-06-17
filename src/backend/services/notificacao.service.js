const logger = require("../utils/logger");

let sendMessageFunction = null;

function setNotifySendMessage(fn) {
  sendMessageFunction = fn;
}

function normalizarJid(numero) {
  const limpo = String(numero).replace(/\D/g, "");
  return limpo.includes("@") ? numero : `${limpo}@s.whatsapp.net`;
}

async function notificarAtendente(ticket) {
  if (!sendMessageFunction) return;

  const numero = process.env.ATENDENTE_NUMBER;
  if (!numero) {
    logger.warn("ATENDENTE_NUMBER não configurado — notificação ignorada.");
    return;
  }

  const jid = normalizarJid(numero);
  const tz  = process.env.TZ_NEGOCIO || "America/Maceio";
  const criadoEm = new Date(ticket.createdAt).toLocaleString("pt-BR", { timeZone: tz });

  const mensagem =
    "🔔 *Novo Ticket Aberto!*\n\n" +
    `🎫 Protocolo: *#${ticket.protocolo}*\n` +
    `📂 Tipo: ${ticket.type}\n` +
    `👤 Cliente: ${ticket.customerName}\n` +
    `🪪 CPF: ${ticket.cpf || "Não informado"}\n` +
    `📋 Descrição: _${ticket.description}_\n` +
    `🏷️ Setor: ${ticket.sector || "geral"}\n` +
    `🕐 Horário: ${criadoEm}`;

  try {
    await sendMessageFunction(jid, mensagem);
    logger.info(`Atendente notificado (${jid})`);
  } catch (err) {
    logger.error(`Erro ao notificar atendente: ${err.message}`);
  }
}

/**
 * Notifica o atendente somente se possível — usado fora do horário comercial
 * para registrar o ticket sem acionar alerta urgente imediato.
 * Envia uma mensagem mais discreta, indicando que será visto no próximo expediente.
 */
async function notificarSeDisponivel(ticket) {
  if (!sendMessageFunction) return;

  const numero = process.env.ATENDENTE_NUMBER;
  if (!numero) {
    logger.warn("ATENDENTE_NUMBER não configurado — notificação ignorada.");
    return;
  }

  const jid = normalizarJid(numero);
  const tz  = process.env.TZ_NEGOCIO || "America/Maceio";
  const criadoEm = new Date(ticket.createdAt).toLocaleString("pt-BR", { timeZone: tz });

  const mensagem =
    "📋 *Ticket registrado fora do horário*\n\n" +
    `🎫 Protocolo: *#${ticket.protocolo}*\n` +
    `📂 Tipo: ${ticket.type}\n` +
    `👤 Cliente: ${ticket.customerName}\n` +
    `📋 Descrição: _${ticket.description}_\n` +
    `🕐 Registrado em: ${criadoEm}\n\n` +
    "_Retorne ao cliente no próximo expediente._";

  try {
    await sendMessageFunction(jid, mensagem);
    logger.info(`[Notificação fora de horário] Atendente notificado (${jid}) — ticket #${ticket.protocolo}`);
  } catch (err) {
    logger.error(`Erro ao notificar atendente (fora de horário): ${err.message}`);
  }
}

module.exports = { notificarAtendente, notificarSeDisponivel, setNotifySendMessage };
