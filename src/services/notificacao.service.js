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
 * Notifica o atendente somente se for possível — usado fora do horário comercial
 * para registrar o ticket sem disparar alerta imediato.
 * O comportamento atual é idêntico ao notificarAtendente, mas a separação
 * semântica facilita implementar lógicas distintas (ex: fila de notificações,
 * agendamento para o próximo expediente) sem alterar os flows.
 */
async function notificarSeDisponivel(ticket) {
  // Por ora registra no log mas não envia mensagem fora do horário
  logger.info(
    `[Notificação] Ticket #${ticket.protocolo} registrado fora do horário — atendente não notificado.`
  );
}

module.exports = { notificarAtendente, notificarSeDisponivel, setNotifySendMessage };
