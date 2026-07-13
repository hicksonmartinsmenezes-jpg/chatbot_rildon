/**
 * Política de senha — aplicada em todo lugar que define/troca senha:
 * criação de usuário (user.routes.js), reset por admin (user.routes.js),
 * troca pelo próprio usuário (user.service.js) e bootstrap do primeiro
 * admin (scripts/create-admin.js).
 *
 * REGRA ATUAL (2026-07-13): PIN numérico de exatamente 4 dígitos, para
 * todos os perfis (inclusive admin) — a pedido explícito do usuário, que
 * foi avisado que isso é uma redução de segurança em relação à política
 * anterior (mín. 10 caracteres + 3 das 4 classes de caractere) e decidiu
 * seguir assim mesmo assim para simplificar o cadastro/uso no dia a dia.
 *
 * Mitigação que permanece em vigor: loginLimiter (rate-limiters.js) limita
 * tentativas de login a 10/min por IP, o que dificulta (mas não elimina)
 * um ataque de força bruta online contra um espaço de só 10.000 senhas
 * possíveis. Não há proteção equivalente contra um vazamento do hash
 * (bcrypt) do banco — um PIN de 4 dígitos é rápido de quebrar offline.
 */

const PIN_LENGTH = 4;
const _PIN_RE = new RegExp(`^\\d{${PIN_LENGTH}}$`);

// PINs óbvios/sequenciais — bloqueados mesmo tendo o formato certo.
const PINS_COMUNS = new Set([
  "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999",
  "1234", "4321", "0123", "9876", "1122", "2580", "6969", "1212", "1010"
]);

/**
 * Valida a força de uma senha (PIN numérico de 4 dígitos).
 * @returns {{ valido: boolean, erro: string|null }}
 */
function validarForcaSenha(senha) {
  const s = String(senha || "");

  if (!_PIN_RE.test(s)) {
    return {
      valido: false,
      erro: `A senha deve ter exatamente ${PIN_LENGTH} dígitos numéricos (ex: 4821).`
    };
  }

  if (PINS_COMUNS.has(s)) {
    return {
      valido: false,
      erro: "Esse PIN é muito óbvio/sequencial. Escolha outro."
    };
  }

  return { valido: true, erro: null };
}

module.exports = { validarForcaSenha, PIN_LENGTH };
