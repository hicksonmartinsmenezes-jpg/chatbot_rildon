/**
 * catalogo-aplicacao-ia.service.js (Issue #23, pedido do usuário 2026-08-26)
 *
 * Cache em disco do texto de "aplicação" (veículo/máquina compatível) já
 * reorganizado pela IA (ver organizarAplicacaoIA em ai.service.js), keyed
 * pelo HASH do texto CRU original — não pelo código do produto, porque
 * muitos produtos diferentes compartilham EXATAMENTE o mesmo texto de
 * aplicação (mesma origem/fabricante no ERP do X2), então isso evita
 * reprocessar (e gastar chamada de IA) o mesmo texto várias vezes.
 *
 * Por que cache em vez de processar toda vez que o PDF é gerado: o texto de
 * aplicação é sempre o mesmo depois de organizado uma vez — reprocessar a
 * cada exportação de PDF gastaria IA à toa e deixaria a geração do catálogo
 * lenta (rate limit do provedor de IA, ver PROVIDER.intervalMs em
 * ai.service.js — pode chegar a 20s por chamada no provedor free tier
 * padrão). Duas formas de popular o cache:
 *   1. Script CLI offline (scripts/organizar-aplicacoes-ia.js) — roda sem
 *      pressa, sem cap, processa um fabricante inteiro (ou todos) antes do
 *      usuário precisar imprimir.
 *   2. Melhor esforço limitado no controller (catalogo.controller.js) — ao
 *      clicar "Gerar catálogo completo" pela 1ª vez pra um fabricante nunca
 *      processado, tenta organizar um número PEQUENO de textos novos
 *      (maxNovos) antes de gerar o PDF, pra não deixar a resposta HTTP
 *      pendurada por muito tempo. Os textos que sobrarem ficam sem
 *      aplicação organizada nessa exportação (o card simplesmente omite o
 *      bloco) — na próxima exportação (ou depois de rodar o script CLI),
 *      mais produtos já estarão em cache.
 */
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const { organizarAplicacaoIA } = require("./ai.service");

const CACHE_PATH = path.join(__dirname, "../config/catalogo-x2/aplicacao-ia-cache.json");

let _cache = null; // Map<hashDoTextoCru, textoOrganizado> — carregado sob demanda

function _hash(texto) {
  return crypto.createHash("sha1").update(texto, "utf8").digest("hex");
}

function _carregarCache() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      _cache = new Map(Object.entries(raw));
    } else {
      _cache = new Map();
    }
  } catch (err) {
    logger.warn(`[Catálogo-IA] Falha ao ler cache (${err.message}) — iniciando cache vazio.`);
    _cache = new Map();
  }
  return _cache;
}

// Escrita via arquivo temporário + rename (atômico no mesmo filesystem) —
// evita deixar o cache corrompido/truncado se o processo cair no meio de
// um fs.writeFileSync direto (o mesmo cuidado já documentado na memória do
// projeto sobre corrupção de arquivo em escrita concorrente).
function _salvarCache() {
  const objeto = Object.fromEntries(_cache);
  const tmp = `${CACHE_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(objeto, null, 2), "utf8");
  fs.renameSync(tmp, CACHE_PATH);
}

// Organiza (com IA, respeitando cache) o texto de aplicação dos produtos
// passados. Muta cada `produto` in-place, setando `aplicacaoOrganizada`
// quando disponível (cache hit OU processado agora com sucesso) — produtos
// sem `aplicacao` ou cujo texto falhou na IA ficam sem esse campo (quem
// desenha o PDF trata a ausência como "omitir o bloco", nunca quebra).
//
// `maxNovos` limita quantos textos ÚNICOS NOVOS (sem cache ainda) essa
// chamada processa de verdade — pensado pro caminho síncrono do controller
// (não travar a resposta HTTP com um fabricante nunca visto antes). O
// script CLI offline chama isso com maxNovos=Infinity.
async function anexarAplicacoesOrganizadas(produtos, { maxNovos = 10 } = {}) {
  const cache = _carregarCache();

  // Dedup: muitos produtos compartilham o mesmo texto cru — processa cada
  // texto ÚNICO só uma vez, independente de quantos produtos o usam.
  const porHash = new Map(); // hash -> { texto, produtos: [] }
  for (const produto of produtos) {
    const texto = String(produto.aplicacao || "").trim();
    if (!texto) continue;
    const hash = _hash(texto);
    if (!porHash.has(hash)) porHash.set(hash, { texto, produtos: [] });
    porHash.get(hash).produtos.push(produto);
  }

  let processados = 0;
  let novosProcessadosComSucesso = 0;
  let houveMudanca = false;

  for (const [hash, { texto, produtos: produtosDoHash }] of porHash) {
    let organizado = cache.get(hash);

    if (organizado === undefined) {
      if (processados >= maxNovos) continue; // cap atingido — deixa pra próxima rodada
      processados++;
      organizado = await organizarAplicacaoIA(texto);
      // organizarAplicacaoIA distingue "não deu pra tentar de verdade"
      // (undefined — sem chave, circuit breaker de crédito, erro de
      // rede/timeout, resposta HTTP não-OK) de "a IA respondeu e não teve
      // aplicação organizável" (null). Só o segundo caso é seguro gravar
      // como falha permanente ("" no cache) — cachear o primeiro foi o bug
      // real de 2026-08-29: um fabricante grande no meio de um lote quando
      // a Anthropic ficou sem crédito marcou ~49% do cache como "sem
      // aplicação" pra sempre, e nem recarregar crédito destravava, porque
      // o hash já contava como "já tentei". Ver comentário em
      // organizarAplicacaoIA (ai.service.js) pros 3 estados de retorno.
      if (organizado !== undefined) {
        cache.set(hash, organizado || ""); // "" = IA respondeu, não teve o que organizar
        houveMudanca = true;
      }
      if (organizado) novosProcessadosComSucesso++;
    }

    if (organizado) {
      for (const produto of produtosDoHash) produto.aplicacaoOrganizada = organizado;
    }
  }

  if (houveMudanca) {
    try {
      _salvarCache();
    } catch (err) {
      logger.warn(`[Catálogo-IA] Falha ao salvar cache: ${err.message}`);
    }
  }

  const totalUnicos = porHash.size;
  const jaEmCache = totalUnicos - processados;
  logger.info(
    `[Catálogo-IA] aplicação: ${totalUnicos} texto(s) único(s) — ${jaEmCache} já em cache, ` +
    `${novosProcessadosComSucesso}/${processados} novo(s) organizado(s) agora` +
    (processados >= maxNovos && totalUnicos - jaEmCache > processados ? ` (cap de ${maxNovos}/chamada atingido, resto fica pra próxima)` : "")
  );

  return { totalUnicos, jaEmCache, novosProcessados: processados, novosComSucesso: novosProcessadosComSucesso };
}

module.exports = { anexarAplicacoesOrganizadas };
