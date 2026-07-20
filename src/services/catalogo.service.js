/**
 * catalogo.service.js — consulta ao catálogo de seções/linhas de produto
 * (src/config/catalogo-produtos.json), extraído pelo usuário do sistema de
 * estoque da loja em 2026-07-20.
 *
 * Por que existe: o prompt da IA (ai.service.js) tinha só uma lista curada
 * e resumida (EMPRESA.produtos, 21 itens) de que a loja "trabalha com".
 * Isso obrigava a IA a responder de forma vaga ("provavelmente temos") pra
 * qualquer peça fora dessa lista curta — mesmo quando a peça está,
 * literalmente, cadastrada no estoque real. O catálogo completo (397 linhas)
 * é grande demais pra caber sempre no prompt, então aqui expomos duas coisas
 * baratas em tokens:
 *   1. listarSecoes() — as 26 categorias reais (nomes curtos), pra dar à IA
 *      uma visão completa e correta do que a loja vende, sempre presente.
 *   2. buscarNoCatalogo(mensagem) — checagem pontual, por mensagem, se o
 *      cliente citou o nome exato de uma linha de produto catalogada — usada
 *      pra dar à IA confirmação concreta (em vez de achismo) quando aplicável.
 */
const CATALOGO = require("../config/catalogo-produtos.json");

const SECOES = Object.keys(CATALOGO).filter(chave => chave !== "_sobre");

function _normalizar(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentuação
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Índice plano pré-computado uma única vez no load do módulo.
const INDICE = SECOES.flatMap(secao =>
  CATALOGO[secao].map(linha => ({ secao, linha, linhaNormalizada: _normalizar(linha) }))
);

function listarSecoes() {
  return SECOES;
}

/**
 * Procura, na mensagem do cliente, nomes de linha de produto que batem
 * EXATAMENTE (como substring normalizada) com algo do catálogo real.
 * Propositalmente simples (substring, não NLP/fuzzy): o objetivo é reduzir
 * falso "não sei"/"provavelmente" da IA só quando há certeza alta — match
 * fraco/impreciso é pior que não confirmar nada.
 */
function buscarNoCatalogo(mensagem, { limite = 3 } = {}) {
  const msgNormalizada = _normalizar(mensagem);
  if (msgNormalizada.length < 3) return [];

  const encontrados = [];
  for (const item of INDICE) {
    // Ignora linhas muito curtas (ex: siglas de 2-3 letras) pra evitar
    // match espúrio dentro de outra palavra da mensagem.
    if (item.linhaNormalizada.length < 4) continue;
    if (msgNormalizada.includes(item.linhaNormalizada)) {
      encontrados.push(item);
      if (encontrados.length >= limite) break;
    }
  }
  return encontrados;
}

module.exports = { listarSecoes, buscarNoCatalogo };
