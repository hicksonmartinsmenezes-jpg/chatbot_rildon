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
const LEVELS = {
  SUCCESS: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  ACCESS: 0
};

const ENV_LEVEL =
  (process.env.LOG_LEVEL || "info").toUpperCase();

const MIN_LEVEL =
  LEVELS[ENV_LEVEL] !== undefined
    ? LEVELS[ENV_LEVEL]
    : 1;

// 2026-10-09 (auditoria de performance): o log de ACCESS é o de maior volume
// do sistema (uma linha por requisição HTTP, e o painel faz polling), e era o
// que mais pesava quando cada linha custava 3 syscalls bloqueantes. Agora dá
// pra desligar só ele sem perder INFO/WARN/ERROR: LOG_HTTP_ACCESS=false.
const HTTP_ACCESS_ATIVO = String(process.env.LOG_HTTP_ACCESS || "true") !== "false";

// Permite silenciar o stdout (o Docker já grava tudo que vai pro console no
// json-file driver; em produção isso é duplicação pura).
const STDOUT_ATIVO = String(process.env.LOG_STDOUT || "true") !== "false";

function format(level, message) {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}

// ---------------------------------------------------------------------------
// Escrita em arquivo
//
// 2026-10-09 (auditoria de performance — CAUSA RAIZ da lentidão geral):
// a versão anterior fazia, EM TODA LINHA DE LOG, três syscalls BLOQUEANTES:
//   fs.existsSync() + fs.statSync()  (dentro de rotateIfNeeded)
//   fs.appendFileSync()
// Como `src/logs/` fica num bind mount do Docker (volumes: - .:/app no
// docker-compose), cada appendFileSync ali custa ordens de magnitude mais que
// num volume nativo. Com o painel fazendo polling, uma linha de ACCESS por
// requisição, uma linha de INFO por mensagem e uma por mapeamento LID, isso
// somava milhares de syscalls bloqueantes por minuto — travando o event loop
// por mais de 15 segundos seguidos. Daí vinha TODO o resto: o pool do Postgres
// matando conexões no handshake ("Connection terminated due to connection
// timeout"), o keepalive do WhatsApp falhando (código 408), a reconexão
// trazendo a lista inteira de contatos de volta e travando de novo.
//
// Agora cada nível tem um WriteStream persistente: a escrita vira um append
// em buffer, assíncrono, sem syscall bloqueante no caminho quente. A rotação
// passou a ser contabilizada por bytes escritos (contador em memória), em vez
// de um statSync por linha.
// ---------------------------------------------------------------------------
const streams   = {};   // nível -> WriteStream
const escritos  = {};   // nível -> bytes escritos desde a última rotação

function tamanhoAtual(filePath) {
  // Só no boot (uma vez por nível), pra rotação continuar correta depois de um
  // restart com arquivo já grande.
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function getStream(level) {
  if (streams[level]) return streams[level];

  const filePath = files[level];
  escritos[level] = tamanhoAtual(filePath);

  const s = fs.createWriteStream(filePath, { flags: "a" });
  // Um erro de disco no log NUNCA pode derrubar o processo: sem este handler,
  // um EACCES/ENOSPC vira 'error' não tratado no stream e mata o Node.
  s.on("error", (err) => {
    console.error("Erro no stream de log:", err.message);
    delete streams[level];
  });
  streams[level] = s;
  return s;
}

function rotacionar(level) {
  const filePath = files[level];
  const s = streams[level];
  delete streams[level];
  escritos[level] = 0;

  if (s) s.end();

  // Rotação assíncrona: mantém até 3 arquivos (.1, .2, .3), igual ao
  // comportamento anterior, mas sem bloquear o event loop.
  (async () => {
    try {
      for (let i = 3; i >= 1; i--) {
        const older = `${filePath}.${i}`;
        const newer = i === 1 ? filePath : `${filePath}.${i - 1}`;
        try {
          await fs.promises.rename(newer, older);
        } catch {
          // Arquivo não existe nesse degrau — normal.
        }
      }
    } catch {
      // Silencioso — rotação nunca deve interromper o fluxo principal.
    }
  })();
}

function write(level, message) {
  if (LEVELS[level] !== undefined && LEVELS[level] < MIN_LEVEL && level !== "ACCESS") return;

  const line  = format(level, message);

  if (STDOUT_ATIVO) {
    const color = colors[level] || "";
    console.log(`${color}${line}${colors.RESET}`);
  }

  const filePath = files[level];
  if (!filePath) return;

  try {
    const s = getStream(level);
    const dados = line + "\n";
    s.write(dados);

    escritos[level] = (escritos[level] || 0) + Buffer.byteLength(dados);
    if (escritos[level] >= MAX_LOG_SIZE) rotacionar(level);
  } catch (err) {
    console.error("Erro ao escrever log:", err.message);
  }
}

function httpLogger(req, res, next) {
  if (!HTTP_ACCESS_ATIVO) return next();
  if (req.originalUrl === "/health") return next();

  const start = Date.now();
  res.on("finish", () => {
    write("ACCESS", `${req.method} ${req.originalUrl} ${res.statusCode} - ${Date.now() - start}ms`);
  });

  next();
}

// Fecha os streams no shutdown pra não perder as últimas linhas em buffer.
function flushLogs() {
  for (const level of Object.keys(streams)) {
    try { streams[level].end(); } catch { /* best-effort */ }
    delete streams[level];
  }
}

module.exports = {
  info:    (msg) => write("INFO",    msg),
  warn:    (msg) => write("WARN",    msg),
  error:   (msg) => write("ERROR",   msg),
  success: (msg) => write("SUCCESS", msg),
  access:  (msg) => write("ACCESS",  msg),
  httpLogger,
  flushLogs
};
