const express = require("express");
const {
  getSettings,
  saveSettings,
  resetSettings
} = require("../services/settings.service");
const logger = require("../utils/logger");

const router = express.Router();

router.get("/settings", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: "Erro ao carregar configurações." });
  }
});

router.put("/settings", async (req, res) => {
  try {
    logger.info(`Recebendo configurações`);

    const settings = await saveSettings(req.body || {});

    logger.success("Configurações salvas");

    res.json(settings);
  } catch (error) {
    logger.error("❌ Erro real ao salvar configurações:", error);

    res.status(500).json({
      error: "Erro ao salvar configurações.",
      details: error.message
    });
  }
});

router.post("/settings/reset", async (req, res) => {
  try {
    const settings = await resetSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: "Erro ao restaurar configurações." });
  }
});

module.exports = router;
