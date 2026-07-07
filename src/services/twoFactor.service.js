/**
 * Autenticação de dois fatores (TOTP, RFC 6238) — compatível com Google
 * Authenticator, Authy, 1Password etc. Fluxo:
 *
 * 1. setup(usuario)      → gera segredo pendente + QR code, NÃO ativa ainda.
 * 2. confirmSetup(...)   → usuário prova que configurou certo (envia 1 código
 *                          válido); só aí o segredo vira ativo e geramos os
 *                          códigos de backup (mostrados 1x em texto puro).
 * 3. login normal valida usuário/senha e, se totpEnabled, cria um desafio
 *    pendente (ver two_factor_challenges) em vez de abrir sessão direto.
 * 4. verifyLoginChallenge(...) valida o código TOTP OU um backup code contra
 *    o desafio pendente e, se ok, quem chama (auth.routes.js) abre a sessão.
 */

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { authenticator } = require("otplib");
const QRCode = require("qrcode");

const userRepository = require("../repositories/user.repository");
const pool = require("../database/postgres");

const EMPRESA_LABEL = "Rildon Eletropeças";
const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_SALT_ROUNDS = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 min para digitar o código

/** Gera um segredo pendente + QR code para o usuário escanear. Não ativa 2FA ainda. */
async function setup(userId, usuario) {
  const secret = authenticator.generateSecret();
  await userRepository.setTotpPendingSecret(userId, secret);

  const otpauthUrl = authenticator.keyuri(usuario, EMPRESA_LABEL, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  return { secret, qrCodeDataUrl };
}

function gerarBackupCodes(qtd = BACKUP_CODE_COUNT) {
  return Array.from({ length: qtd }, () => {
    // 10 dígitos hex maiúsculos em blocos "XXXX-XXXX-XX" — fácil de digitar/ler
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 10)}`;
  });
}

/** Confirma o setup com um código do app autenticador. Ativa o 2FA e gera backup codes. */
async function confirmSetup(userId, codigo) {
  const user = await userRepository.findById(userId);

  if (!user?.totpPendingSecret) {
    throw new Error("Nenhum setup de 2FA pendente. Inicie o processo novamente.");
  }

  const valido = authenticator.verify({ token: String(codigo || ""), secret: user.totpPendingSecret });
  if (!valido) {
    throw new Error("Código inválido. Confira o horário do dispositivo e tente de novo.");
  }

  const backupCodes = gerarBackupCodes();
  const hashes = await Promise.all(
    backupCodes.map(code => bcrypt.hash(code, BACKUP_CODE_SALT_ROUNDS))
  );

  await userRepository.enableTotp(userId, user.totpPendingSecret, hashes);

  // Códigos de backup só existem em texto puro aqui — nunca são
  // recuperáveis depois (só o hash fica salvo).
  return { backupCodes };
}

/** Desliga o 2FA (chamado só depois de confirmar a senha atual na rota). */
async function disable(userId) {
  await userRepository.disableTotp(userId);
}

/** Cria um desafio pendente após validar usuário/senha no login. */
async function criarDesafioLogin(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  await pool.query(
    `INSERT INTO two_factor_challenges (token, user_id, expires_at) VALUES ($1, $2, $3)`,
    [token, userId, expiresAt]
  );

  return { token, expiresIn: CHALLENGE_TTL_MS };
}

async function buscarDesafio(token) {
  const result = await pool.query(
    `SELECT token, user_id, expires_at FROM two_factor_challenges WHERE token = $1 LIMIT 1`,
    [token]
  );
  return result.rows[0] || null;
}

async function removerDesafio(token) {
  await pool.query(`DELETE FROM two_factor_challenges WHERE token = $1`, [token]);
}

/**
 * Valida o segundo fator (código TOTP ou backup code) para um desafio de login.
 * @returns {Promise<{ userId: string }>}
 */
async function verificarDesafioLogin(challengeToken, codigo) {
  const desafio = await buscarDesafio(challengeToken);

  if (!desafio) {
    throw new Error("Desafio de autenticação inválido ou expirado. Faça login novamente.");
  }

  if (Date.now() > Number(desafio.expires_at)) {
    await removerDesafio(challengeToken);
    throw new Error("Tempo para digitar o código expirou. Faça login novamente.");
  }

  const user = await userRepository.findById(desafio.user_id);
  if (!user || !user.totpEnabled) {
    await removerDesafio(challengeToken);
    throw new Error("Usuário inválido para este desafio.");
  }

  const codigoStr = String(codigo || "").trim();

  // 1. Tenta como código TOTP de 6 dígitos.
  if (authenticator.verify({ token: codigoStr, secret: user.totpSecret })) {
    await removerDesafio(challengeToken);
    return { userId: user.id };
  }

  // 2. Tenta como backup code de uso único.
  const backupHashes = Array.isArray(user.totpBackupCodes) ? user.totpBackupCodes : [];
  for (let i = 0; i < backupHashes.length; i++) {
    // Poucos códigos (≤8) — sequencial é aceitável aqui, sem necessidade de Promise.all.
    const bate = await bcrypt.compare(codigoStr, backupHashes[i]);
    if (bate) {
      const restantes = backupHashes.filter((_, idx) => idx !== i);
      await userRepository.updateBackupCodes(user.id, restantes);
      await removerDesafio(challengeToken);
      return { userId: user.id, usouBackupCode: true };
    }
  }

  throw new Error("Código incorreto.");
}

/** Limpeza de desafios expirados — chamada periodicamente (ver server.js). */
async function limparDesafiosExpirados() {
  await pool.query(`DELETE FROM two_factor_challenges WHERE expires_at < $1`, [Date.now()]);
}

module.exports = {
  setup,
  confirmSetup,
  disable,
  criarDesafioLogin,
  verificarDesafioLogin,
  limparDesafiosExpirados
};
