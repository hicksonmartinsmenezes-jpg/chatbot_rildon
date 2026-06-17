const logger = require("../utils/logger");

function backupData() {
  logger.info(
    "Backup JSON desativado: o sistema agora utiliza PostgreSQL como fonte principal."
  );
}

function startAutoBackup() {
  logger.info(
    "Auto backup JSON desativado. Use pg_dump para backup real do PostgreSQL."
  );
}

module.exports = {
  backupData,
  startAutoBackup
};