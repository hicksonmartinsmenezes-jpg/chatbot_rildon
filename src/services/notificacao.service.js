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

  // Formata data/hora legível
  const criadoEm = new Date(ticket.createdAt).toLocaleString("pt-BR", {
    timeZone: process.env.TZ_ATENDIMENTO || "America/Maceio"
  });

  const mensagem =
    `🔔 *Novo Ticket Aberto!*\n\n` +
    `🎫 Protocolo: *#${ticket.protocolo}*\n` +
    `📂 Tipo: ${ticket.type}\n` +
    `👤 Cliente: ${ticket.customerName}\n` +
    `🪪 CPF: ${ticket.cpf}\n` +
    `📋 Descrição: _${ticket.description}_\n` +
    `🏷️ Setor: ${ticket.sector}\n` +
    `🕐 Horário: ${criadoEm}`;

  try {
    await sendMessageFunction(jid, mensagem);
    logger.info(`Atendente notificado (${jid})`);
  } catch (err) {
    logger.error(`Erro ao notificar atendente: ${err.message}`);
  }
}

module.exports = { notificarAtendente, setNotifySendMessage };
