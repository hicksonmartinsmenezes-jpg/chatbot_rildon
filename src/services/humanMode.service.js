/**
 * humanMode.service.js
 *
 * Controla o modo de atendimento humano por usuário.
 * Quando ativo para um userId, o bot não processa mensagens —
 * o atendente humano assume o controle.
 */

const logger = require("../utils/logger");

// Mapa de userId → { ativo: bool, ativadoEm: Date }
const _modoHumano = new Map();

/**
 * Verifica se o modo humano está ativo para um usuário.
 */
function estaAtivo(userId) {
  return _modoHumano.get(userId)?.ativo === true;
}

/**
 * Ativa o modo humano para um usuário.
 */
function ativar(userId) {
  _modoHumano.set(userId, { ativo: true, ativadoEm: new Date() });
  logger.info(`[humanMode] Ativado para ${userId}`);
}

/**
 * Desativa o modo humano para um usuário.
 */
function desativar(userId) {
  _modoHumano.delete(userId);
  logger.info(`[humanMode] Desativado para ${userId}`);
}

/**
 * Lista todos os usuários em modo humano.
 */
function listar() {
  return [..._modoHumano.entries()]
    .filter(([, v]) => v.ativo)
    .map(([userId, v]) => ({ userId, ativadoEm: v.ativadoEm }));
}

module.exports = { estaAtivo, ativar, desativar, listar };
