const fs   = require("fs");
const path = require("path");

const logsDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// Tamanho máximo de cada arquivo de log antes de ser rotacionado (padrão: 10 MB)
const MAX_LOG_SIZE = parseInt(process.env.MAX_LOG_SIZE_MB || "10") * 1024 * 1024;

const files = {
  INFO:    path.join(logsDir, "info.log"),
  WARN:    path.join(logsDir, "warn.log"),
  ERROR:   path.join(logsDir, "error.log"),
  SUCCESS: path.join(logsDir, "success.log"),
  ACCESS:  path.join(logsDir, "access.log")
};

const colors = {
  INFO:    "\x1b[36m",
  WARN:    "\x1b[33m",
  ERROR:   "\x1b[31m",
  SUCCESS: "\x1b[32m",
  ACCESS:  "\x1b[35m",
  RESET:   "\x1b[0m"
};

// Níveis numéricos para filtragem (LOG_LEVEL=warn suprime INFO e SUCCESS)
const LEVELS = { SUCCESS: 0, INFO: 1, WARN: 2, ERROR: 3, ACCESS: 0 };
const ENV_LEVEL = (process.env.LOG_LEVEL || "info").toUpperCase();
const MIN_LEVEL = LEVELS[ENV_LEVEL] ?? 1;

function format(level, message) {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

/**
 * Rotaciona o arquivo de log se exceder MAX_LOG_SIZE.
 * O arquivo atual é renomeado para <name>.1.log; versões anteriores incrementam.
 */
function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const { size } = fs.statSync(filePath);
    if (size < MAX_LOG_SIZE) return;

    // Mantém até 3 arquivos rotacionados
    for (let i = 3; i >= 1; i--) {
      const older = `${filePath}.${i}`;
      const newer = i === 1 ? filePath : `${filePath}.${i - 1}`;
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    }
  } catch (_) {
    // Silencioso — não deve interromper o fluxo principal
  }
}

function write(level, message) {
  if (LEVELS[level] !== undefined && LEVELS[level] < MIN_LEVEL && level !== "ACCESS") return;

  const line  = format(level, message);
  const color = colors[level] || "";

  console.log(`${color}${line}${colors.RESET}`);

  const filePath = files[level];
  if (!filePath) return;

  try {
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line + "\n");
  } catch (err) {
    console.error("Erro ao escrever log:", err.message);
  }
}

function httpLogger(req, res, next) {
  if (req.originalUrl === "/health") return next();

  const start = Date.now();
  res.on("finish", () => {
    write("ACCESS", `${req.method} ${req.originalUrl} ${res.statusCode} - ${Date.now() - start}ms`);
  });

  next();
}

module.exports = {
  info:    (msg) => write("INFO",    msg),
  warn:    (msg) => write("WARN",    msg),
  error:   (msg) => write("ERROR",   msg),
  success: (msg) => write("SUCCESS", msg),
  access:  (msg) => write("ACCESS",  msg),
  httpLogger
};
