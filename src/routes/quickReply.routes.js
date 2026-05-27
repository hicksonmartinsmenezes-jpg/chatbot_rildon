const express = require("express");

const {
  getQuickReplies,
  saveQuickReplies
} = require("../services/quickReply.service");

const router = express.Router();

router.get("/quick-replies", async (req, res) => {
  const replies = await getQuickReplies();
  res.json(replies);
});

router.put("/quick-replies", async (req, res) => {
  const saved = await saveQuickReplies(req.body || []);
  res.json(saved);
});

module.exports = router;