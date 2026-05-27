const crypto = require("crypto");
const { ler, transacao } = require("./db.service");

const ARQUIVO = "audit.json";

async function getAuditLogs() {
  const logs = await ler(ARQUIVO);
  return Array.isArray(logs) ? logs : [];
}

async function saveAuditLogs(logs) {
  await transacao(ARQUIVO, () => logs);
  return logs;
}

async function auditLog({ user, action, target, details }) {
  const logs = await getAuditLogs();

  const entry = {
    id: crypto.randomUUID(),
    userId: user?.id || "sistema",
    userName: user?.nome || user?.usuario || "Sistema",
    userRole: user?.perfil || "system",
    action,
    target,
    details: details || {},
    createdAt: new Date().toISOString()
  };

  logs.unshift(entry);

  await saveAuditLogs(logs.slice(0, 1000));

  return entry;
}

module.exports = {
  getAuditLogs,
  auditLog
};