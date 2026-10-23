// Catálogos promocionais gerados pelo programa "Catálogo Rildon" (aba
// "Promocionais", pedido do usuário 2026-10-23). Cada um fica guardado no
// servidor (PDF + um JSON com nome/data), para aparecer na lista de todas as
// máquinas da loja. Não entra na rotina das segundas-feiras: o PDF nunca muda
// depois de gerado (ids novos a cada geração), só é apagado a pedido.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = process.env.CATALOGOS_PRONTOS_DIR || path.join(__dirname, "..", "..", "catalogos-prontos");
const PASTA = path.join(BASE, "promocionais");
const ID_RE = /^[a-z0-9]{6,40}$/;

function _idValido(id) {
  return typeof id === "string" && ID_RE.test(id);
}

function _nomeLimpo(nome) {
  const n = String(nome || "").replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return n || "Catálogo promocional";
}

function listar() {
  try {
    return fs.readdirSync(PASTA)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const id = f.slice(0, -5);
        if (!_idValido(id) || !fs.existsSync(path.join(PASTA, id + ".pdf"))) return null;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(PASTA, f), "utf8"));
          return { id, nome: _nomeLimpo(m.nome), criadoEm: m.criadoEm || "", itens: Number(m.itens) || 0, modo: m.modo || "linha" };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  } catch {
    return []; // pasta ainda não existe
  }
}

// Produtos (código interno) que estão em algum catálogo promocional guardado, com o preço
// promocional do catálogo mais recente que traz o produto (null = catálogo sem preço para ele).
// O painel e o programa da loja são processos separados e qualquer um pode criar/apagar
// um promocional, então o mapa é relido a cada 30 s em vez de invalidado só localmente.
let _emPromocao = new Map();
let _emPromocaoEm = 0;
function _carregarEmPromocao() {
  const mapa = new Map();
  const criado = new Map();
  try {
    for (const f of fs.readdirSync(PASTA)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      if (!_idValido(id) || !fs.existsSync(path.join(PASTA, id + ".pdf"))) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(PASTA, f), "utf8"));
        const quando = String(m.criadoEm || "");
        const precos = m.precos && typeof m.precos === "object" ? m.precos : {};
        for (const c of Array.isArray(m.codigos) ? m.codigos : []) {
          const k = String(c);
          if (criado.has(k) && criado.get(k) > quando) continue; // já tem um promocional mais novo
          const v = Number(precos[k]);
          mapa.set(k, Number.isFinite(v) && v > 0 ? v : null);
          criado.set(k, quando);
        }
      } catch { /* meta ilegível: ignora */ }
    }
  } catch { /* pasta ainda não existe */ }
  _emPromocao = mapa;
  _emPromocaoEm = Date.now();
}
function emPromocao(codigo) {
  if (Date.now() - _emPromocaoEm > 30000) _carregarEmPromocao();
  return _emPromocao.has(String(codigo));
}
// Campos que a busca anexa a cada produto: { promocao, precoPromocao }.
function infoPromocao(codigo) {
  const em = emPromocao(codigo);
  return { promocao: em, precoPromocao: em ? _emPromocao.get(String(codigo)) : null };
}

function caminhoPdf(id) {
  if (!_idValido(id)) return null;
  const p = path.join(PASTA, id + ".pdf");
  return fs.existsSync(p) ? p : null;
}

// Destino temporário para o gerador escrever; só vira catálogo da lista em publicar().
function novoDestino() {
  fs.mkdirSync(PASTA, { recursive: true });
  const id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const final = path.join(PASTA, id + ".pdf");
  const tmp = `${final}.tmp`;
  const stream = fs.createWriteStream(tmp);
  const fechado = new Promise((resolve, reject) => {
    stream.once("close", resolve);
    stream.once("error", reject);
  });
  return {
    id,
    stream,
    async publicar({ nome, itens, modo, codigos, precos }) {
      await fechado;
      if (fs.statSync(tmp).size <= 0) {
        fs.rmSync(tmp, { force: true });
        throw new Error("PDF vazio");
      }
      fs.renameSync(tmp, final);
      const meta = { nome: _nomeLimpo(nome), criadoEm: new Date().toISOString(), itens: Number(itens) || 0, modo: modo || "linha" };
      fs.writeFileSync(path.join(PASTA, id + ".json"), JSON.stringify({ ...meta, codigos: (codigos || []).map(String), precos: precos || {} }));
      _emPromocaoEm = 0;
      return { id, ...meta };
    },
    descartar() {
      try { stream.destroy(); } catch { /* já fechado */ }
      fs.rmSync(tmp, { force: true });
    }
  };
}

function remover(id) {
  if (!_idValido(id)) return false;
  const existe = !!caminhoPdf(id);
  fs.rmSync(path.join(PASTA, id + ".pdf"), { force: true });
  fs.rmSync(path.join(PASTA, id + ".json"), { force: true });
  _emPromocaoEm = 0;
  return existe;
}

module.exports = { listar, emPromocao, infoPromocao, caminhoPdf, novoDestino, remover };
