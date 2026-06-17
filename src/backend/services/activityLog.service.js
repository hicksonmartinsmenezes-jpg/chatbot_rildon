const activityLogRepository = require("../repositories/activity-log.repository");
const logger = require("../utils/logger");

async function getLogs() {
  return activityLogRepository.findAll(500);
}

async function addLog(user, action, description, extra = {}) {
  return activityLogRepository.create({
    userId:    user?.id || "system",
    userName:  user?.nome || user?.usuario || "Sistema",
    action,
    description,
    extra,
    createdAt: new Date()
  });
}

logger.info("📋 PostgreSQL: logs carregados");

module.exports = {
  getLogs,
  addLog
};
