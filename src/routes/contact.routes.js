const express = require("express");
const axios   = require("axios");
const { getProfilePhotoUrl } = require("../config/whatsapp");
const logger = require("../utils/logger");

const router = express.Router();

router.get("/contacts/photo", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "userId é obrigatório." });
    }

    const photoUrl = await getProfilePhotoUrl(userId);

    if (!photoUrl) {
      return res.set("Cache-Control", "no-store").status(404).end();
    }

    // Proxia a imagem pelo backend para evitar CORS e URLs expiradas no browser
    const response = await axios.get(photoUrl, {
      responseType: "arraybuffer",
      timeout: 8000
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", "public, max-age=300"); // cache 5 min no browser
    return res.send(Buffer.from(response.data));

  } catch (error) {
    logger.error(`Erro ao buscar foto: ${error.message}`);
    return res.set("Cache-Control", "no-store").status(404).end();
  }
});

module.exports = router;
