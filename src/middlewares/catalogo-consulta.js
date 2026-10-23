// Consulta do catálogo SEM login — usada pelo programa Windows da loja
// ("Catálogo Rildon", pasta desktop-catalogo/). Pedido do usuário (2026-10-20):
// "preciso que remova login dele, não tem necessidade".
//
// Regras (todas precisam valer, senão a requisição segue o fluxo normal, que
// exige sessão):
//   1. só as rotas do catálogo que o programa usa: leitura (GET/HEAD) e, desde
//      2026-10-21 (pedido do usuário: "deixa editável também e não apenas
//      leitura"), as edições feitas pelo balcão — trocar/ocultar/adicionar foto,
//      corrigir a Linha do produto e os PDFs de seleção/promocional. Continuam
//      FORA: recarregar estoque e recarregar o catálogo inteiro (manutenção);
//   2. cabeçalho marcador `X-Consulta-Catalogo: 1` (o programa envia; o painel
//      web normal não envia, então o login dele continua obrigatório);
//   3. origem na rede interna (IP privado) e SEM cabeçalhos de proxy/túnel —
//      acesso vindo da internet (Cloudflare/proxy) nunca entra por aqui.
const net = require("net");

const ROTAS_LEITURA = [
  /^\/catalogo\/(buscar|secoes|linhas|fabricantes|montadoras|fabricantes-completo|buscar-codigo|buscar-nome|exportar-pdf|fotos-versao|pronto-versao|promocionais|exe-versao|exe-download)\/?$/,
  /^\/catalogo\/promocionais\/[a-z0-9]+\/pdf\/?$/,
  /^\/catalogo\/produtos\/[^/]+\/fotos(\/[^/]+(\/[^/]+)?)?\/?$/
];

// Edições liberadas para o programa do balcão (POST). Mesma porteira dos GETs:
// cabeçalho do programa + rede interna + sem proxy.
const ROTAS_ESCRITA = [
  /^\/catalogo\/produtos\/[^/]+\/(foto-preferida|foto-ocultar|linha)\/?$/,
  /^\/catalogo\/produtos\/[^/]+\/fotos\/upload\/?$/,
  /^\/catalogo\/exportar-selecionados-pdf\/?$/,
  /^\/catalogo\/promocional\/(exportar-pdf|importar-arquivo)\/?$/
];

// Apagar um catálogo promocional guardado (aba "Promocionais", 2026-10-23) — único DELETE liberado.
const ROTAS_APAGAR = [/^\/catalogo\/promocionais\/[a-z0-9]+\/?$/];

function ipPrivado(ip) {
  let v = String(ip || "").replace(/^::ffff:/i, "");
  if (net.isIPv6(v)) return v === "::1" || /^f[cd][0-9a-f]{2}:/i.test(v);
  if (!net.isIPv4(v)) return false;
  const [a, b] = v.split(".").map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function consultaCatalogoSemLogin(catalogoRouter) {
  return function (req, res, next) {
    const leitura = req.method === "GET" || req.method === "HEAD";
    if (!leitura && req.method !== "POST" && req.method !== "DELETE") return next();
    if (req.get("x-consulta-catalogo") !== "1") return next();
    if (req.get("x-forwarded-for") || req.get("cf-connecting-ip") || req.get("forwarded")) return next();
    if (!ipPrivado(req.socket && req.socket.remoteAddress)) return next();
    const lista = leitura ? ROTAS_LEITURA : req.method === "DELETE" ? ROTAS_APAGAR : ROTAS_ESCRITA;
    const liberada = lista.some((re) => re.test(req.path));
    if (!liberada) return next();
    return catalogoRouter(req, res, next);
  };
}

module.exports = { consultaCatalogoSemLogin, ipPrivado, ROTAS_LEITURA, ROTAS_ESCRITA, ROTAS_APAGAR };
