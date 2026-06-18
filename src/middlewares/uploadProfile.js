const multer = require("multer");
const path   = require("path");
const fs     = require("fs");

const uploadDir = path.join(__dirname, "../uploads/profiles");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const ALLOWED_IMAGES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"]
]);
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const safe = ext.replace(/[^.a-z0-9]/g, "");
    cb(null, `${req.user.id}-${Date.now()}${safe}`);
  }
});

module.exports = multer({
  storage,
  limits: { fileSize: MAX_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const expectedMime = ALLOWED_IMAGES.get(ext);
    if (!expectedMime || expectedMime !== String(file.mimetype || "").toLowerCase()) {
      return cb(new Error("Apenas imagens JPEG, PNG, WebP ou GIF válidas são permitidas."));
    }
    cb(null, true);
  }
});
