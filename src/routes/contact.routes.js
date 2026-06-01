const express = require("express");
const { getProfilePhotoUrl } = require("../config/whatsapp");
const logger = require("../utils/logger");

const router = express.Router();

router.get("/contacts/photo", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        error: "userId é obrigatório."
      });
    }

    const photoUrl = await getProfilePhotoUrl(userId);

    if (!photoUrl) {
      return res.status(204).end();
    }

    return res.redirect(photoUrl);

  } catch (error) {
    logger.error(error);
    return res.status(204).end();
  }
});

module.exports = router;