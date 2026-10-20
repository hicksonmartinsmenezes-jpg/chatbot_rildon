// Catálogos Completos PRONTOS: o PDF de cada fabricante é gerado antes (em
// segundo plano) e guardado em disco; abrir o catálogo só entrega o arquivo,
// sem esperar a geração. Pedido do usuário (2026-10-20): "o catálogo já
// precisa estar pronto, sem perder tempo esperando ficar completo".
//
// Pasta: <raiz do projeto>/catalogos-prontos (o repositório é montado em /app
// no container, então os arquivos sobrevivem a reinício).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");

const PASTA = process.env.CATALOGOS_PRONTOS_DIR || path.join(__dirname, "..", "..", "catalogos-prontos");

function arquivo(chave) {
  const texto = String(chave || "");
  const slug = texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "catalogo";
  const hash = crypto.createHash("md5").update(texto).digest("hex").slice(0, 6);
  return path.join(PASTA, `${slug}-${hash}.pdf`);
}

function existe(chave) {
  try {
    return fs.statSync(arquivo(chave)).size > 0;
  } catch {
    return false;
  }
}

// Entrega o arquivo pronto (inline, com tamanho — o visualizador abre na hora).
function enviar(res, chave) {
  const caminho = arquivo(chave);
  const { size } = fs.statSync(caminho);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", size);
  res.setHeader("Content-Disposition", `inline; filename="catalogo-completo.pdf"`);
  return new Promise((resolve, reject) => {
    const leitura = fs.createReadStream(caminho);
    leitura.on("error", reject);
    res.on("close", resolve);
    leitura.pipe(res);
  });
}

// Destino temporário para o gerador escrever; só vira "pronto" em publicar().
function novoDestino(chave) {
  fs.mkdirSync(PASTA, { recursive: true });
  const final = arquivo(chave);
  const tmp = `${final}.${process.pid}.tmp`;
  const stream = fs.createWriteStream(tmp);
  const fechado = new Promise((resolve, reject) => {
    stream.once("close", resolve);
    stream.once("error", reject);
  });
  return {
    stream,
    // Espera o arquivo fechar e o publica (troca atômica); descarta se falhar.
    async publicar() {
      await fechado;
      if (fs.statSync(tmp).size > 0) fs.renameSync(tmp, final);
      else fs.rmSync(tmp, { force: true });
    },
    descartar() {
      try { stream.destroy(); } catch { /* já fechado */ }
      fs.rmSync(tmp, { force: true });
    }
  };
}

function limparTodos() {
  if (!fs.existsSync(PASTA)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(PASTA)) {
    if (f.endsWith(".pdf") || f.endsWith(".tmp")) { fs.rmSync(path.join(PASTA, f), { force: true }); n += 1; }
  }
  return n;
}

function contar() {
  try { return fs.readdirSync(PASTA).filter((f) => f.endsWith(".pdf")).length; } catch { return 0; }
}

// ─── Aquecimento: gera o que ainda não está pronto, um fabricante por vez ───
let rodando = false;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Resposta "de mentira" para chamar o mesmo handler HTTP sem cliente: reaproveita
// toda a regra do Catálogo Completo (filtros, IA, estilo) e só descarta a saída.
function respostaDescartavel() {
  const { Writable } = require("stream");
  const res = new Writable({ write(_c, _e, cb) { cb(); } });
  res.headersSent = false;
  res.statusCode = 200;
  res.setHeader = () => {};
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (corpo) => { res.corpo = corpo; res.end(); return res; };
  return res;
}

async function aquecerTodos({ forcar = false, pausaMs = 3000 } = {}) {
  if (rodando) return { jaRodando: true };
  rodando = true;
  const inicio = Date.now();
  const resumo = { gerados: 0, ignorados: 0, semProduto: 0, falhas: 0 };
  try {
    if (forcar) limparTodos();
    const { listarFabricantesCatalogoCompleto } = require("./catalogo-x2.service");
    const { exportarPdfHandler } = require("../controllers/catalogo.controller");
    const opcoes = listarFabricantesCatalogoCompleto();
    logger.info(`[Catálogos prontos] aquecendo ${opcoes.length} fabricante(s)...`);
    for (const o of opcoes) {
      if (existe(o.value)) { resumo.ignorados += 1; continue; }
      const res = respostaDescartavel();
      try {
        await exportarPdfHandler({ query: { fabricante: o.value }, __apenasGerar: true }, res);
        if (existe(o.value)) resumo.gerados += 1;
        else if (res.statusCode === 404) resumo.semProduto += 1;
        else resumo.falhas += 1;
      } catch (err) {
        resumo.falhas += 1;
        logger.warn(`[Catálogos prontos] falha em "${o.value}": ${err.message}`);
      }
      await esperar(pausaMs); // folga para o atendimento do WhatsApp não engasgar
    }
    logger.info(`[Catálogos prontos] concluído em ${Math.round((Date.now() - inicio) / 1000)}s: ${JSON.stringify(resumo)}`);
  } catch (err) {
    logger.error(`[Catálogos prontos] erro no aquecimento: ${err.message}`);
  } finally {
    rodando = false;
  }
  return resumo;
}

// Liga o aquecimento: ao subir (só preenche o que falta) e todo dia de madrugada
// (refaz tudo — pega preços, fotos e aplicações novas).
function iniciar({ horaRefazer = 3 } = {}) {
  if (process.env.CATALOGOS_PRONTOS_AUTO === "0") return;
  setTimeout(() => aquecerTodos(), 90 * 1000);
  let ultimoDia = null;
  setInterval(() => {
    const agora = new Date();
    const dia = agora.toDateString();
    if (agora.getHours() === horaRefazer && ultimoDia !== dia) {
      ultimoDia = dia;
      aquecerTodos({ forcar: true });
    }
  }, 10 * 60 * 1000).unref();
}

module.exports = { arquivo, existe, enviar, novoDestino, limparTodos, contar, aquecerTodos, iniciar };
