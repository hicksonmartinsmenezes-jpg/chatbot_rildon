const activityLogRepository =
  require("../repositories/activity-log.repository");

async function getLogs() {
  return activityLogRepository.findAll(
    500
  );
}

async function addLog(
  user,
  action,
  description,
  extra = {}
) {

  return activityLogRepository.create({
    userId:
      user?.id || "system",

    userName:
      user?.nome ||
      user?.usuario ||
      "Sistema",

    action,
    description,
    extra,

    createdAt:
      new Date()
  });
}

console.log(
  "📋 PostgreSQL: logs carregados"
);

module.exports = {
  getLogs,
  addLog
};