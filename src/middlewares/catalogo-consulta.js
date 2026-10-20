// Consulta do catálogo SEM login — usada pelo programa Windows da loja
// ("Catálogo Rildon", pasta desktop-catalogo/). Pedido do usuário (2026-10-20):
// "preciso que remova login dele, não tem necessidade".
//
// Regras (todas precisam valer, senão a requisição segue o fluxo normal, que
// exige sessão):
//   1. só leitura (GET/HEAD) e só rotas de CONSULTA do catálogo — nada de
//      upload/edição/recarregar, nada de PDF promocional (POST);
//   2. cabeçalho marcador `X-Consulta-Catalogo: 1` (o programa envia; o painel
//      web normal não envia, então o login dele continua obrigatório);
//   3. origem na rede interna (IP privado) e SEM cabeçalhos de proxy/túnel —
//      acesso vindo da internet (Cloudflare/proxy) nunca entra por aqui.
const net = require("net");

const ROTAS_LEITURA = [
  /^\/catalogo\/(buscar|secoes|linhas|fabricantes|montadoras|fabricantes-completo|buscar-codigo|buscar-nome|exportar-pdf|fotos-versao)\/?$/,
  /^\/catalogo\/produtos\/[^/]+\/fotos(\/[^/]+(\/[^/]+)?)?\/?$/
];

function ipPrivado(ip) {
  let v = String(ip || "").replace(/^::ffff:/i, "");
  if (net.isIPv6(v)) return v === "::1" || /^f[cd][0-9a-f]{2}:/i.test(v);
  if (!net.isIPv4(v)) return false;
  const [a, b] = v.split(".").map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

function consultaCatalogoSemLogin(catalogoRouter) {
  return function (req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.get("x-consulta-catalogo") !== "1") return next();
    if (req.get("x-forwarded-for") || req.get("cf-connecting-ip") || req.get("forwarded")) return next();
    if (!ipPrivado(req.socket && req.socket.remoteAddress)) return next();
    if (!ROTAS_LEITURA.some((re) => re.test(req.path))) return next();
    if (req.query && req.query.incluirOcultas !== undefined) return next(); // fotos ocultas = só logado
    return catalogoRouter(req, res, next);
  };
}

module.exports = { consultaCatalogoSemLogin, ipPrivado, ROTAS_LEITURA };
