const express = require("express");
const axios   = require("axios");
const { getProfilePhotoUrl } = require("../config/whatsapp");
const logger = require("../utils/logger");

const router = express.Router();

// Rate limit por userId (30/min) e por IP global (200/min)
const _photoRateUser = new Map();
const _photoRateIp   = new Map();
setInterval(() => { _photoRateUser.clear(); _photoRateIp.clear(); }, 60_000);

function photoRateOk(userId, ip) {
  const userCount = (_photoRateUser.get(userId) || 0) + 1;
  _photoRateUser.set(userId, userCount);
  if (userCount > 30) return false;

  const ipCount = (_photoRateIp.get(ip) || 0) + 1;
  _photoRateIp.set(ip, ipCount);
  if (ipCount > 200) return false;

  return true;
}

router.get("/contacts/photo", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId || typeof userId !== "string" || userId.length > 200) {
      return res.status(400).json({ error: "userId inválido." });
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (!photoRateOk(userId, ip)) {
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
