const express = require("express");
const { getLogs } = require("../services/activityLog.service");

const router = express.Router();

router.get("/activity-logs", async (req, res) => {
  try {
    const logs = await getLogs();

    res.json(logs);
  } catch (error) {
    res.status(500).json({
      error: "Erro ao carregar logs."
    });
  }
});

module.exports = router;