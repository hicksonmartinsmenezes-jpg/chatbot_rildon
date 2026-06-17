const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const pool         = require("../database/postgres");

const router = express.Router();

router.get("/activity-logs", asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || "1"));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || "50")));
  const offset = (page - 1) * limit;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM activity_logs`)
  ]);

  const total = countRes.rows[0].total;

  res.json({
    data:       dataRes.rows,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

module.exports = router;
