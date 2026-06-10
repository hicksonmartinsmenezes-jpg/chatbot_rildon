const express = require("express");
const axios   = require("axios");
const { getProfilePhotoUrl } = require("../config/whatsapp");
const logger = require("../utils/logger");

const router = express.Router();

// Rate limit simples: máx 30 requisições por userId por minuto
const _photoRateMap = new Map();
setInterval(() => _photoRateMap.clear(), 60_000);

function photoRateOk(userId) {
  const count = (_photoRateMap.get(userId) || 0) + 1;
  _photoRateMap.set(userId, count);
  return count <= 30;
}

router.get("/contacts/photo", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || typeof userId !== "string" || userId.length > 200) {
      return res.status(400).json({ error: "userId inválido." });
    }

    if (!photoRateOk(userId)) {
      return res.set("Cache-Control", "no-store").status(429).end();
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
    res.set("Cache-Control", "private, max-age=300"); // cache 5 min só no browser do usuário
    return res.send(Buffer.from(response.data));

  } catch (error) {
    logger.error(`Erro ao buscar foto: ${error.message}`);
    return res.set("Cache-Control", "no-store").status(404).end();
  }
});

module.exports = router;
