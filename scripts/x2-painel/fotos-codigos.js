/**
 * scripts/x2-painel/fotos-codigos.js
 *
 * PEDIDO DO USUARIO (2026-10-17): "as vezes pedem para atualizarmos as fotos
 * no sistema, essas fotos devem ir para o pdf" -> em "Atualizar Fotos", colar
 * uma LISTA DE CODIGOS e o painel procura cada um no X2 e baixa as fotos.
 *
 * Funcoes puras (sem rede/disco), testaveis em tests/x2-painel-fotos-codigos.test.js.
 */

const LIMITE_CODIGOS = 500;

/**
 * Aceita texto colado (uma linha por item, ou separado por virgula, ponto e
 * virgula, tab ou espaco) ou um array. Tira vazios e repetidos, preservando a
 * ordem. Codigos do X2 sao alfanumericos sem espaco.
 */
function parseListaCodigos(entrada) {
  const bruto = Array.isArray(entrada) ? entrada.join("\n") : String(entrada || "");
  const vistos = new Set();
  const codigos = [];
  for (const parte of bruto.split(/[\s,;]+/)) {
    const c = parte.trim().replace(/^["']+|["']+$/g, "");
    if (!c || vistos.has(c)) continue;
    vistos.add(c);
    codigos.push(c);
  }
  return codigos;
}

/**
 * mapa: Map<codigo, string[] slugs>. Separa os codigos que ja existem no
 * catalogo (e em quais secoes) dos que ainda nao existem (precisam de cadastro
 * antes de baixar foto).
 */
function classificarCodigos(codigos, mapa) {
  const conhecidos = [];
  const novos = [];
  const slugs = new Set();
  for (const c of codigos) {
    const secoes = mapa.get(c);
    if (secoes && secoes.length) {
      conhecidos.push(c);
      secoes.forEach((s) => slugs.add(s));
    } else {
      novos.push(c);
    }
  }
  return { conhecidos, novos, slugs: [...slugs] };
}

/** Monta Map<codigo, slugs[]> a partir de { slug: [{codigo}, ...] }. */
function montarMapaCodigos(produtosPorSlug) {
  const mapa = new Map();
  for (const [slug, produtos] of Object.entries(produtosPorSlug)) {
    for (const p of produtos || []) {
      const c = String(p.codigo).trim();
      if (!mapa.has(c)) mapa.set(c, []);
      if (!mapa.get(c).includes(slug)) mapa.get(c).push(slug);
    }
  }
  return mapa;
}

module.exports = { LIMITE_CODIGOS, parseListaCodigos, classificarCodigos, montarMapaCodigos };
