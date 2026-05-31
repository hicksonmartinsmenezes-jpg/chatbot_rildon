/**
 * Utilitários de validação de entrada.
 *
 * MELHORIA v7:
 * - sanitizarTexto() remove caracteres de controle e limita tamanho
 * - validarTamanho() usa MAX_CHARS_INPUT do .env
 * - validarCPF() e validarNome() mantidos
 */

const MAX_CHARS = parseInt(process.env.MAX_CHARS_INPUT || "500");

// ─── Sanitização ──────────────────────────────────────────────────────────────

/**
 * Remove caracteres de controle (exceto \n e \t) e limita o tamanho.
 * Use em toda entrada de texto livre antes de persistir.
 */
function sanitizarTexto(texto, limite = MAX_CHARS) {
  if (typeof texto !== "string") return "";
  return texto
    // Remove caracteres de controle exceto newline e tab
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, limite);
}

// ─── Tamanho ──────────────────────────────────────────────────────────────────

function validarTamanho(texto, minimo = 1, maximo = MAX_CHARS) {
  const t = sanitizarTexto(texto, maximo + 1); // +1 para detectar excesso
  if (t.length < minimo) return { ok: false, erro: "minimo" };
  if (t.length > maximo) return { ok: false, erro: "maximo" };
  return { ok: true };
}

function mensagemTamanhoInvalido(minimo = 1) {
  return `⚠️ Sua mensagem é muito longa. Por favor, seja mais objetivo (máximo ${MAX_CHARS} caracteres).`;
}

// ─── CPF ──────────────────────────────────────────────────────────────────────

function validarCPF(cpf) {
  const nums = String(cpf || "").replace(/\D/g, "");
  if (nums.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(nums)) return false; // sequências como 111.111.111-11

  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(nums[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(nums[9])) return false;

  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(nums[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(nums[10]);
}

function formatarCPF(cpf) {
  const nums = String(cpf || "").replace(/\D/g, "");
  return nums.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
}

// ─── CNPJ ─────────────────────────────────────────────────────────────────────

function validarCNPJ(cnpj) {
  const nums = String(cnpj || "").replace(/\D/g, "");
  if (nums.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(nums)) return false; // todos iguais

  const calc = (n, p) => {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += parseInt(nums[i]) * p[i];
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  return (
    calc(12, p1) === parseInt(nums[12]) &&
    calc(13, p2) === parseInt(nums[13])
  );
}

function formatarCNPJ(cnpj) {
  const nums = String(cnpj || "").replace(/\D/g, "");
  return nums.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}

// ─── Nome ─────────────────────────────────────────────────────────────────────

function validarNome(nome) {
  const n = sanitizarTexto(nome).replace(/\s+/g, " ");
  // Exige ao menos duas palavras com pelo menos 2 letras cada
  const partes = n.split(" ").filter((p) => /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,}$/.test(p));
  return partes.length >= 2;
}

module.exports = {
  sanitizarTexto,
  validarTamanho,
  mensagemTamanhoInvalido,
  validarCPF,
  formatarCPF,
  validarCNPJ,
  formatarCNPJ,
  validarNome,
};
