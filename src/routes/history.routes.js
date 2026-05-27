const express = require("express");
const router = express.Router();
const { getHistoryHandler } = require("../controllers/history.controller");

router.get("/history", getHistoryHandler);

module.exports = router;
