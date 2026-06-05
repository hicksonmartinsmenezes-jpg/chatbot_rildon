const { listHistory } = require("../services/history.service");
const logger = require("../utils/logger");

async function getHistoryHandler(req, res) {
  try {
    const { userId } = req.query;

    const page = Math.max(
      parseInt(req.query.page || "1", 10),
      1
    );

    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200
    );

    const offset = (page - 1) * limit;

    const result = await listHistory({
      userId,
      limit,
      offset
    });

    res.json({
      page,
      limit,
      count: result.length,
      data: result
    });

  } catch (err) {
    logger.error(
      "❌ Erro ao buscar histórico:",
      err.message
    );

    res.status(500).json({
      page: 1,
      limit: 50,
      count: 0,
      data: []
    });
  }
}

module.exports = {
  getHistoryHandler
};