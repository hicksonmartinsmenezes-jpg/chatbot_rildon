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
  res.setHeader("X-Catalogo-Versao", versao());
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

// "Versão" dos catálogos: muda sempre que os PDFs guardados são descartados
// (foto/produto/estoque atualizado). O programa .exe da loja guarda uma cópia
// local de cada catálogo com essa versão e só baixa de novo quando ela muda.
const ARQ_VERSAO = path.join(PASTA, "versao.txt");
function versao() {
  try {
    const v = fs.readFileSync(ARQ_VERSAO, "utf8").trim();
    if (v) return v;
  } catch { /* ainda não existe */ }
  return novaVersao();
}
function novaVersao() {
  const v = String(Date.now());
  try {
    fs.mkdirSync(PASTA, { recursive: true });
    fs.writeFileSync(ARQ_VERSAO, v);
  } catch (err) {
    logger.warn(`[Catálogos prontos] não consegui gravar a versão: ${err.message}`);
  }
  return v;
}

function limparTodos() {
  novaVersao();
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

// Com o catálogo rodando em contêiner próprio (src/catalogo-server.js), quem aquece os PDFs é
// ELE. O processo do painel só aquece se não achar o contêiner do catálogo no ar.
async function cederAoCatalogo() {
  if (process.env.CATALOGO_PROCESSO === "catalogo") return false;
  try {
    const { urlDoOutro } = require("./espelho.service");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(urlDoOutro() + "/health", { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// Fuso da loja. ⚠️ Corrigido 2026-10-23 (varredura): o contêiner roda em UTC — conferido ao
// vivo, `date` devolve "UTC" e new Date().getHours() marcava 15 quando na loja era meio-dia.
// Como a regra abaixo usava a hora do contêiner, a regeneração de segunda "às 20h" caía às
// 17h da loja, dentro do expediente — exatamente o que o comentário dizia querer evitar.
// Agora a hora e o dia da semana são sempre lidos no horário da LOJA, não importa o fuso em
// que o processo esteja rodando.
const FUSO_LOJA = process.env.FUSO_LOJA || "America/Sao_Paulo";

function agoraNaLoja(quando = new Date()) {
  return new Date(quando.toLocaleString("en-US", { timeZone: FUSO_LOJA }));
}

// Liga o aquecimento. Por padrão NÃO aquece ao subir (gerar 100+ catálogos no meio do
// expediente deixa o servidor lento); refaz tudo SÓ nas segundas-feiras às 20h da loja
// (pedido do usuário, 2026-10-22), com folga até as 00h, quando os programas da loja baixam
// os catálogos atualizados (ver desktop-catalogo/main.js).
function iniciar({ horaRefazer = 20, diaRefazer = 1, aquecerAoSubir = false } = {}) {
  if (process.env.CATALOGOS_PRONTOS_AUTO === "0") return;
  if (aquecerAoSubir) setTimeout(() => aquecerTodos(), 90 * 1000);
  let ultimoDia = null;
  setInterval(() => {
    const agora = agoraNaLoja();
    const dia = agora.toDateString();
    if (agora.getDay() === diaRefazer && agora.getHours() === horaRefazer && ultimoDia !== dia) {
      ultimoDia = dia;
      cederAoCatalogo().then((ceder) => { if (!ceder) aquecerTodos({ forcar: true }); });
    }
  }, 10 * 60 * 1000).unref();
}

module.exports = { versao, arquivo, existe, enviar, novoDestino, limparTodos, contar, aquecerTodos, iniciar, agoraNaLoja, FUSO_LOJA };
