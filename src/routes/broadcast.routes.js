const express = require("express");

const {
  createBroadcast,
  listBroadcasts,
  getBroadcastRecipients,
  startBroadcast,
  getBroadcastAudience
} = require("../services/broadcast.service");

const router = express.Router();

router.get("/broadcasts", async (req, res) => {
  try {
    const broadcasts = await listBroadcasts();
    res.json(broadcasts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/broadcasts", async (req, res) => {
  try {
    const { title, message, recipients } = req.body;

    const broadcast = await createBroadcast({
      title,
      message,
      recipients,
      createdBy: req.user?.nome || req.user?.usuario || null
    });

    res.status(201).json(broadcast);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/broadcasts/audience/:type", async (req, res) => {
  try {
    const audience = await getBroadcastAudience(req.params.type);
    res.json(audience);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/broadcasts/:id/recipients", async (req, res) => {
  try {
    const recipients = await getBroadcastRecipients(req.params.id);
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/broadcasts/:id/start", async (req, res) => {
  try {
    const result = await startBroadcast(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;