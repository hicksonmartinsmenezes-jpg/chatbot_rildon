/**
 * Utilitários de validação de entrada.
 *
 * - sanitizarTexto() remove caracteres de controle e limita tamanho
 * - normalizar()     trim + lowercase + remove acentos (uso nos flows)
 * - validarTamanho() usa MAX_CHARS_INPUT do .env
 * - validarCPF(), validarCNPJ(), validarNome() mantidos
 */

const MAX_CHARS = parseInt(process.env.MAX_CHARS_INPUT || "500");

// ─── Sanitização ──────────────────────────────────────────────────────────────

function sanitizarTexto(texto, limite = MAX_CHARS) {
  if (typeof texto !== "string") return "";
  return texto
    // eslint-disable-next-line no-control-regex -- remoção intencional de caracteres de controle da entrada
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim()
    .slice(0, limite);
}

/**
 * Normaliza entrada de usuário: trim + lowercase + remove acentos.
 * Use em todos os pontos de decisão dos flows.
 */
function normalizar(str) {
  return String(str || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// ─── Tamanho ──────────────────────────────────────────────────────────────────

function validarTamanho(texto, minimo = 1, maximo = MAX_CHARS) {
  const t = sanitizarTexto(texto, maximo + 1);
  if (t.length < minimo) return { ok: false, erro: "minimo" };
  if (t.length > maximo) return { ok: false, erro: "maximo" };
  return { ok: true };
}

function mensagemTamanhoInvalido() {
  return `⚠️ Sua mensagem é muito longa. Por favor, seja mais objetivo (máximo ${MAX_CHARS} caracteres).`;
}

// ─── CPF ──────────────────────────────────────────────────────────────────────

function validarCPF(cpf) {
  const nums = String(cpf || "").replace(/\D/g, "");
  if (nums.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(nums)) return false;

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
  if (/^(\d)\1{13}$/.test(nums)) return false;

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
  // Aceita hífens e apóstrofos dentro de nomes: D'Angelo, Jean-Pierre, O'Brien
  const partes = n.split(" ").filter((p) => /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'-]*[A-Za-zÀ-ÖØ-öø-ÿ]$/.test(p) && p.length >= 2);
  // Aceita nome único com ≥3 chars (apelido, artista, nome estrangeiro: Rildon, Prince, Cher)
  if (partes.length === 1 && partes[0].length >= 3) return true;
  // Fallback: nome que não passou no filtro mas tem ≥3 chars e só letras/hífen/apóstrofo
  if (partes.length === 0 && n.trim().length >= 3 && /^[A-Za-zÀ-ÖØ-öø-ÿ'-]+$/.test(n.trim())) return true;
  return partes.length >= 2;
}

module.exports = {
  sanitizarTexto,
  normalizar,
  validarTamanho,
  mensagemTamanhoInvalido,
  validarCPF,
  formatarCPF,
  validarCNPJ,
  formatarCNPJ,
  validarNome,
};
