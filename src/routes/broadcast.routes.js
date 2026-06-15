const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const {
  createBroadcast,
  listBroadcasts,
  getBroadcastRecipients,
  startBroadcast,
  cancelBroadcast,
  deleteBroadcast,
  retryFailedRecipients,
  getBroadcastAudience,
  getBroadcastStats
} = require("../services/broadcast.service");

const router = express.Router();

router.get("/broadcasts", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page  || "1"));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20")));
    const broadcasts = await listBroadcasts({ page, limit });
    res.json(broadcasts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const uploadDir = path.join(__dirname, "../uploads/campaigns");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = `campaign-${Date.now()}${ext}`;
    cb(null, name);
  }
});

const ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Apenas imagens são permitidas."));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(ext)) {
      return cb(new Error("Extensão de arquivo não permitida."));
    }
    cb(null, true);
  }
});


router.post("/broadcasts", async (req, res) => {
  try {
    const { title, message, recipients, imageUrl } = req.body;

    const broadcast = await createBroadcast({
      title,
      message,
      recipients,
      imageUrl,
      createdBy: req.user?.nome || req.user?.usuario || null
    });

    res.status(201).json(broadcast);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


router.post("/broadcasts/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Nenhuma imagem enviada." });
    }

    // Validação adicional: extensão real do arquivo salvo no disco
    const savedExt = path.extname(req.file.filename).toLowerCase();
    if (!ALLOWED_IMAGE_EXTS.has(savedExt)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Tipo de arquivo não permitido." });
    }

    res.json({ url: `/uploads/campaigns/${req.file.filename}` });
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: err.message });
  }
});

router.get("/broadcasts/audience/:type", async (req, res) => {
  try {
    const { tag, atendenteId } = req.query;
    const audience = await getBroadcastAudience(req.params.type, { tag, atendenteId });
    res.json(audience);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


router.get("/broadcasts/stats", async (req, res) => {
  try {
    const stats = await getBroadcastStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
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

router.post("/broadcasts/:id/cancel", async (req, res) => {
  try {
    const result = await cancelBroadcast(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/broadcasts/:id/retry", async (req, res) => {
  try {
    const result = await retryFailedRecipients(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/broadcasts/:id", async (req, res) => {
  try {
    const result = await deleteBroadcast(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;