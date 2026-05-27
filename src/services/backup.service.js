const fs   = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const dataDir   = path.join(__dirname, "../data");
const backupDir = path.join(__dirname, "../backups");

// Número máximo de pastas de backup mantidas. As mais antigas são removidas.
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || "30");

const ARQUIVOS = [
  "users.json",
  "tickets.json",
  "history.json",
  "settings.json",
  "audit.json",
  "quick_replies.json"
];

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Remove os backups mais antigos mantendo apenas MAX_BACKUPS.
 * Ordenação por nome de pasta (ISO timestamp → ordem cronológica correta).
 */
function rotacionarBackups() {
  try {
    const pastas = fs
      .readdirSync(backupDir)
      .filter((f) => fs.statSync(path.join(backupDir, f)).isDirectory())
      .sort(); // ISO date strings ordenam lexicograficamente

    const excesso = pastas.length - MAX_BACKUPS;
    if (excesso <= 0) return;

    for (let i = 0; i < excesso; i++) {
      const alvo = path.join(backupDir, pastas[i]);
      fs.rmSync(alvo, { recursive: true, force: true });
      logger.info(`Backup antigo removido: ${pastas[i]}`);
    }
  } catch (err) {
    logger.error(`Erro na rotação de backups: ${err.message}`);
  }
}

function backupData() {
  ensureBackupDir();

  const pastaBackup = path.join(backupDir, timestamp());
  fs.mkdirSync(pastaBackup, { recursive: true });

  let copiados = 0;
  for (const arquivo of ARQUIVOS) {
    const origem  = path.join(dataDir, arquivo);
    const destino = path.join(pastaBackup, arquivo);
    if (fs.existsSync(origem)) {
      fs.copyFileSync(origem, destino);
      copiados++;
    }
  }

  logger.success(`Backup criado em: ${pastaBackup} (${copiados} arquivo(s))`);

  rotacionarBackups();
}

function startAutoBackup() {
  // Backup inicial ao ligar
  backupData();

  // Backup a cada 24 h
  setInterval(() => backupData(), 24 * 60 * 60 * 1000);
}

module.exports = { backupData, startAutoBackup };
