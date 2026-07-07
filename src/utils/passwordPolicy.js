/**
 * Política de senha — aplicada em todo lugar que define/troca senha:
 * criação de usuário (user.routes.js), reset por admin (user.routes.js),
 * troca pelo próprio usuário (user.service.js) e bootstrap do primeiro
 * admin (scripts/create-admin.js).
 *
 * Regra: mínimo 10 caracteres + pelo menos 3 das 4 classes de caractere
 * (minúscula, maiúscula, dígito, símbolo) + não pode ser uma senha comum
 * conhecida. Mantém o padrão de mensagem de erro em português já usado
 * no resto do projeto.
 */

const MIN_LENGTH = 10;
const MIN_CLASSES = 3;

// Senhas mais usadas/óbvias — bloqueadas mesmo que tecnicamente atendam
// aos requisitos de tamanho/complexidade (ex: "Password123!").
const SENHAS_COMUNS = new Set([
  "password123", "password1234", "senha123456", "senha1234567",
  "12345678910", "123456789012", "qwertyuiop12", "qwerty123456",
  "admin123456", "administrador", "changeme123", "letmein12345"
]);

/**
 * Valida a força de uma senha.
 * @returns {{ valido: boolean, erro: string|null }}
 */
function validarForcaSenha(senha) {
  const s = String(senha || "");

  if (s.length < MIN_LENGTH) {
    return {
      valido: false,
      erro: `A senha deve ter pelo menos ${MIN_LENGTH} caracteres.`
    };
  }

  const classes = [
    /[a-z]/.test(s), // minúscula
    /[A-Z]/.test(s), // maiúscula
    /[0-9]/.test(s), // dígito
    /[^a-zA-Z0-9]/.test(s) // símbolo
  ].filter(Boolean).length;

  if (classes < MIN_CLASSES) {
    return {
      valido: false,
      erro: "A senha deve combinar pelo menos 3 destes: letra minúscula, letra maiúscula, número e símbolo."
    };
  }

  if (SENHAS_COMUNS.has(s.toLowerCase())) {
    return {
      valido: false,
      erro: "Essa senha é muito comum/previsível. Escolha outra."
    };
  }

  return { valido: true, erro: null };
}

module.exports = { validarForcaSenha, MIN_LENGTH, MIN_CLASSES };
