const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");

const {
  getQuickReplies,
  saveQuickReplies
} = require("../services/quickReply.service");

const router = express.Router();

router.get("/quick-replies", asyncHandler(async (req, res) => {
  const replies = await getQuickReplies();
  res.json(replies);
}));

router.put("/quick-replies", asyncHandler(async (req, res) => {
  const saved = await saveQuickReplies(req.body || []);
  res.json(saved);
}));

module.exports = router;
