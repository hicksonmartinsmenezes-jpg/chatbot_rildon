/**
 * catalogo-x2.service.js — busca estruturada sobre o banco de produtos X2
 * (src/config/catalogo-x2/*.json), extraído do ERP da loja em 2026-07-20 e
 * parseado (campo "ficha") em 2026-07-20.
 *
 * Por que existe: catalogo.service.js já dá à IA confirmação de Seção/Linha
 * ("a loja tem ALTERNADOR"), mas não sabe dizer se um alternador específico
 * SERVE pra um veículo, nem cruzar um código de peça original (OEM) com o
 * produto equivalente cadastrado. Este serviço expõe duas buscas de alta
 * precisão sobre os ~17.400 produtos com ficha técnica parseada:
 *
 *   1. buscarPorCodigoOriginal(texto) — acha token(s) na mensagem que
 *      parecem código de peça (OEM/fabricante) e retorna o(s) produto(s)
 *      cadastrados como equivalente daquele código. Match exato, sem
 *      ambiguidade — seguro pra afirmar com confiança.
 *   2. buscarPorVeiculo(mensagem, linhasCandidatas) — dado um recorte de
 *      linhas candidatas (normalmente já vindo de catalogo.service
 *      .buscarNoCatalogo, que garante a categoria certa), cruza os tokens
 *      da mensagem do cliente com o texto de "Aplicação" (veículos
 *      compatíveis) de cada produto daquela linha. Propositalmente exige
 *      >=2 tokens batendo (ou o único token, se só houver um) — 1 palavra
 *      solta bate por acaso demais pra ser confiável.
 *
 * Os índices são construídos uma única vez no load do módulo. Só os campos
 * necessários pra busca ficam em memória (não o array completo de cada
 * JSON) — o resto é liberado pro GC logo após a indexação.
 */
const fs = require("fs");
const path = require("path");
// PEDIDO DO USUÁRIO (2026-08-07): "Estoque ao vivo no Catálogo/orçamento" —
// anexa qtd/preço de estoque (cache em memória, ver estoque.service.js) em
// cada produto retornado. Cache pode estar vazio logo depois do boot (ainda
// não carregou do banco) ou se a migration 024 não tiver sido aplicada —
// nesse caso obterEstoque() devolve null e o produto aparece normalmente,
// só sem o badge.
const estoqueService = require("./estoque.service");

const DIR_CATALOGO = path.join(__dirname, "../config/catalogo-x2");

function _normalizar(texto) {
  return String(texto || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentuação
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _normalizarCodigo(codigo) {
  return String(codigo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Heurística pra extrair tokens de código (OEM/fabricante) de um texto livre:
// alfanumérico, comprimento >=5, contém pelo menos 1 dígito (evita casar
// palavra comum do português, que não tem dígito).
function _extrairCodigosDoTexto(texto) {
  if (!texto) return [];
  const tokens = String(texto).split(/[^A-Za-z0-9]+/).filter(Boolean);
  return tokens.filter(t => t.length >= 5 && /\d/.test(t)).map(_normalizarCodigo);
}

// ─── Índices (construídos uma vez, no require) ─────────────────────────────
const equivalenteIndex = new Map();   // codigoNormalizado -> [{codigo,nome,secao,linha,referencia}]
const referenciaIndex  = new Map();   // referenciaNormalizada -> {codigo,nome,secao,linha,referencia}
const produtosPorCodigoIndex = new Map(); // codigoInternoNormalizado -> item completo (pra buscarPorCodigo)
const produtosComAplicacao = [];      // [{codigo,nome,secao,linha,referencia,aplicacaoNormalizada}]
// Superset de produtosComAplicacao: TODO produto com ficha, tenha ou não
// texto de aplicação/veículo cadastrado. Pedido do usuário (2026-07-22):
// o painel Catálogo de Produtos precisa dar acesso ao banco de dados
// inteiro (config/catalogo-x2), não só à fatia com aplicação — ~1.900 dos
// 17.400 produtos (peças genéricas: abraçadeira, parafuso, etc.) não citam
// veículo nenhum e ficavam invisíveis em qualquer busca. Usado pelo modo de
// navegação por Seção/Linha (sem marca/modelo) em buscarProdutosPainel.
const todosProdutos = [];
const secoesConhecidas = new Map();   // secaoNormalizada -> secao original (as 26 seções do X2)
const fabricanteCount = new Map();    // fabricante canônico -> quantidade de produtos (pra filtrar ruído no dropdown)

let totalProdutosIndexados = 0;

// ─── Fabricante da peça (não é campo estruturado — pedido do usuário em
// 2026-07-23) ────────────────────────────────────────────────────────────
// O catálogo real não tem campo "fabricante"; o nome do produto segue o
// padrão "<descrição> - <FABRICANTE> - <referência>" em ~71% dos casos
// (confirmado escaneando os 17.417 produtos reais em 2026-07-23). Quando o
// nome tem exatamente 3 blocos separados por " - ", o do meio é o
// fabricante. Com 2 blocos (sem fabricante) ou 4+ (descrição com hífen
// interno, ex: nome de carro "KADET T - CORSA - ASTRA") não dá pra confiar
// no parsing — produto fica sem fabricante identificado, mas continua
// aparecendo normalmente em qualquer busca por veículo/categoria.
function _extrairFabricante(nome) {
  const partes = String(nome || "").split(" - ");
  if (partes.length !== 3) return null;
  return partes[1].trim();
}

// Mesma marca grafada de formas diferentes no catálogo real (achado
// escaneando os 17.417 produtos em 2026-07-23) — mapeado pro nome canônico
// mais frequente, senão o dropdown de fabricante mostraria a mesma marca 2-3
// vezes.
const FABRICANTE_ALIASES = {
  "MULTI QUALITA": "MULTIQUALITA",
  "MQ": "MULTIQUALITA",
  "MULTILGHT": "MULTILIGHT",
  "MARÍLIA": "MARILIA",
  "SPEED BREAK": "SPEED BRAKE",
};

// Ruído comum que cai no mesmo formato "descrição - X - referência" sem X
// ser um fabricante real (notação de embalagem/voltagem/promoção).
const RUIDO_FABRICANTE_RE = /^(\d+\s*[VA]$|PC\b|P[ÇC]\b|KIT\b|C\/\s*\d|\*)/i;

function _normalizarFabricante(bruto) {
  if (!bruto) return null;
  const limpo = bruto.replace(/\s+/g, " ").trim();
  if (!limpo || RUIDO_FABRICANTE_RE.test(limpo)) return null;
  const upper = limpo.toUpperCase();
  return FABRICANTE_ALIASES[upper] || upper;
}

function _indexarProduto(p) {
  const ficha = p.ficha;
  if (!ficha) return;

  const fabricante = _normalizarFabricante(_extrairFabricante(p.nome));
  // Pedido do usuário (2026-07-30): painel precisa mostrar "Ver referências"
  // — os códigos equivalentes/OEM (de outros fabricantes) que apontam pra
  // essa mesma peça, igual à tela "Equivalentes" do X2. O dado já vem
  // pronto do parser (ficha.equivalentesLista); só precisava ser carregado
  // pro item indexado — antes só era usado internamente pra montar o
  // equivalenteIndex (busca REVERSA: código OEM -> produto), descartado
  // depois. Guarda também o texto das referências cruzadas por família
  // (ex: "Alternador:", "Motor de Partida:"), quando existir.
  const equivalentes = [...new Set(ficha.equivalentesLista || [])];
  const referenciasCruzadas = ficha.referenciasCruzadas && Object.keys(ficha.referenciasCruzadas).length
    ? ficha.referenciasCruzadas
    : null;
  const base = {
    codigo: p.codigo, nome: p.nome, secao: p.secao, linha: p.linha,
    referencia: ficha.referencia || null, fabricante,
    equivalentes, referenciasCruzadas,
    // Código de barras (pedido do usuário, 2026-07-30): usado no cabeçalho
    // do painel "Ver referências", que reproduz o mesmo cartão visual da
    // tela "Equivalentes" do X2 (Código Produto / Código Barras / Código
    // Fornecedor). Já vinha no JSON bruto (p.barras), só não estava
    // indexado pra nenhum uso anterior.
    barras: p.barras || null,
  };
  totalProdutosIndexados++;

  if (fabricante) fabricanteCount.set(fabricante, (fabricanteCount.get(fabricante) || 0) + 1);

  if (p.secao) {
    const secaoNorm = _normalizar(p.secao);
    if (secaoNorm.length >= 4 && !secoesConhecidas.has(secaoNorm)) secoesConhecidas.set(secaoNorm, p.secao);
  }

  // referência própria do produto — às vezes vem só o código ("DNI317720"),
  // às vezes já com o fabricante grudado ("MB1123 - MOBENSANI", achado ao
  // vivo em 2026-07-23 testando busca por código). Indexa só a parte antes
  // do " - " (o código de verdade); o texto completo continua guardado em
  // `referencia` pra exibição, sem mudança.
  if (ficha.referencia) {
    const refCodigoParte = ficha.referencia.includes(" - ") ? ficha.referencia.split(" - ")[0] : ficha.referencia;
    const refNorm = _normalizarCodigo(refCodigoParte);
    if (refNorm.length >= 4 && !referenciaIndex.has(refNorm)) {
      referenciaIndex.set(refNorm, base);
    }

    // Pedido do usuário (2026-07-30, painel "Ver referências"): "aqueles
    // códigos embaixo são outras referências? preciso que coloque todas
    // possíveis". Achado ao vivo: vários fornecedores prefixam a referência
    // do fabricante original com 1-2 letras próprias ao cadastrar a peça —
    // ex: "V1986AE0105" cadastrado aqui pro código Bosch "1986AE0105", ou
    // "SF00MA45253" pro código Bosch "F00MA45253". O equivalente batia
    // exatamente com o produto certo, só não encontrava porque sobrava essa
    // letra a mais na comparação. Registra também a referência SEM esse
    // prefixo como alias — só quando não colide com outra referência já
    // cadastrada, e só se sobrar pelo menos 4 caracteres com 1 dígito (pra
    // não virar match de qualquer coisa).
    for (const cortar of [1, 2]) {
      if (refNorm.length <= cortar) continue;
      const prefixo = refNorm.slice(0, cortar);
      const semPrefixo = refNorm.slice(cortar);
      if (
        /^[A-Z]+$/.test(prefixo) &&
        semPrefixo.length >= 4 &&
        /\d/.test(semPrefixo) &&
        !referenciaIndex.has(semPrefixo)
      ) {
        referenciaIndex.set(semPrefixo, base);
      }
    }
  }

  // códigos equivalentes/OEM (já extraídos pelo parser) + os embutidos em
  // blocos de referência cruzada por família (ex: "Alternador:", "Motor de
  // Partida:" — listam código de outras marcas pro mesmo conjunto).
  const codigos = new Set(ficha.equivalentesLista || []);
  if (ficha.referenciasCruzadas) {
    for (const texto of Object.values(ficha.referenciasCruzadas)) {
      for (const c of _extrairCodigosDoTexto(texto)) codigos.add(c);
    }
  }
  for (const codigo of codigos) {
    const norm = _normalizarCodigo(codigo);
    if (norm.length < 4) continue;
    if (!equivalenteIndex.has(norm)) equivalenteIndex.set(norm, []);
    const lista = equivalenteIndex.get(norm);
    if (!lista.some(item => item.codigo === base.codigo)) lista.push(base);
  }

  // texto de aplicação (veículos compatíveis), pra busca por veículo.
  // Guarda também o Set de palavras isoladas — comparar token por
  // substring-de-string (aplicacaoNormalizada.includes(token)) deixava
  // "GOL" bater dentro de "GOLF" (carro diferente). Comparando contra
  // palavras inteiras evita esse falso positivo.
  let item;
  if (ficha.aplicacao) {
    const aplicacaoNormalizada = _normalizar(ficha.aplicacao);
    const aplicacaoPalavras = new Set(aplicacaoNormalizada.split(" "));
    // PEDIDO DO USUÁRIO (2026-07-27): "não está captando todas as peças...
    // Universal, Diversos". ~1000 produtos (742 "UNIVERSAL" + 261
    // "DIVERSOS") têm aplicação genérica, sem citar nenhum modelo específico
    // ("UNIVERSAL - Veículo Todos os modelos", "Diversos tipos de
    // caminhões...") — servem pra qualquer veículo daquela categoria, mas a
    // busca por veículo (buscarPorVeiculo/buscarProdutosPainel abaixo) exige
    // bater token do modelo pesquisado com o texto de aplicação, então
    // NUNCA apareciam numa busca por veículo específico. Marcado aqui pra
    // essas duas funções poderem incluir o produto mesmo sem bater nenhum
    // token de modelo — só quando a categoria/seção pesquisada bater (ver
    // uso abaixo), pra não poluir toda busca de veículo com peça genérica
    // sem categoria nenhuma informada.
    const universal = aplicacaoPalavras.has("UNIVERSAL") || aplicacaoPalavras.has("DIVERSOS");
    item = {
      ...base,
      aplicacao: ficha.aplicacao,
      aplicacaoNormalizada,
      aplicacaoPalavras,
      faixasAno: _extrairFaixasDeAno(ficha.aplicacao),
      universal,
    };
    produtosComAplicacao.push(item);
    todosProdutos.push(item);
  } else {
    // Sem texto de aplicação — ainda entra em todosProdutos (pra aparecer
    // na navegação por Seção/Linha), só não em produtosComAplicacao (não
    // tem como cruzar com marca/modelo/ano sem texto nenhum de veículo).
    item = { ...base, aplicacao: null, aplicacaoPalavras: new Set(), faixasAno: [] };
    todosProdutos.push(item);
  }

  // código interno do produto (o "codigo" da loja, não a referência do
  // fabricante) — usado por buscarPorCodigo pra aceitar tanto o código
  // interno quanto a referência/equivalente como entrada de busca.
  const codigoInternoNorm = _normalizarCodigo(p.codigo);
  if (codigoInternoNorm) produtosPorCodigoIndex.set(codigoInternoNorm, item);
}

// ─── Extração de faixa de ano (painel Catálogo de Produtos) ────────────────
// Só ~37% dos produtos têm ano cadastrado no texto de aplicação (o resto cita
// só marca/modelo) — confirmado ao vivo em 2026-07-21 rodando um scan no
// catálogo real. Por isso o ano NUNCA é critério de exclusão aqui (decisão do
// usuário): produto sem ano cadastrado continua aparecendo, só não ganha o
// destaque de "ano compatível". Formatos reais observados: "1998 > 2011"
// (faixa fechada) e "2002 >" (faixa aberta, peça ainda em linha).
function _extrairFaixasDeAno(texto) {
  if (!texto) return [];
  const faixas = [];
  const re = /\b((?:19|20)\d{2})\s*>\s*((?:19|20)\d{2})?\b/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    faixas.push({ inicio: Number(m[1]), fim: m[2] ? Number(m[2]) : null });
  }
  return faixas;
}

function _anoCompativel(faixas, anoBuscado) {
  if (!anoBuscado || !faixas || !faixas.length) return false;
  return faixas.some(f => anoBuscado >= f.inicio && (f.fim === null || anoBuscado <= f.fim));
}

function _tokens(texto) {
  return _normalizar(texto).split(" ").filter(t => t.length >= 2);
}

// ─── Sinônimos de MARCA de veículo (pedido do usuário, 2026-07-27) ─────────
// "meu catálogo de consultas não está captando todas as peças... GM -
// General Motors". Achado escaneando o catálogo real: a MESMA marca aparece
// grafada de 3 formas diferentes no texto de aplicação — "GM" (1504
// produtos), "GENERAL MOTORS" (384) e "CHEVROLET" (1110) — tratadas hoje
// como marcas DISTINTAS na busca (aplicacaoPalavras guarda palavra por
// palavra, então "GENERAL MOTORS" vira dois tokens "GENERAL"/"MOTORS",
// nenhum dos dois batendo com uma busca por "GM" ou "Chevrolet"). Resultado:
// ~3000 produtos ficavam invisíveis entre si dependendo de qual grafia o
// atendente/cliente usasse. Diferente de FABRICANTE_ALIASES acima (que é
// sobre o FABRICANTE da peça, não a marca do veículo) — mesma ideia, escopo
// diferente. Só GM tinha esse problema real no scan; a estrutura permite
// adicionar outros grupos se aparecerem casos parecidos no futuro.
const GRUPOS_ALIAS_MARCA = [
  ["GM", "GENERAL", "MOTORS", "CHEVROLET"],
];
const _aliasMarcaIndex = new Map(); // token -> array com o grupo inteiro (incluindo ele mesmo)
for (const grupo of GRUPOS_ALIAS_MARCA) {
  for (const token of grupo) _aliasMarcaIndex.set(token, grupo);
}

// Substitui toda comparação direta `aplicacaoPalavras.has(token)` — também
// aceita bater em qualquer sinônimo conhecido do token buscado (ver
// GRUPOS_ALIAS_MARCA acima). Token sem grupo de alias comporta-se
// exatamente como antes (comparação direta).
function _tokenBateAplicacao(token, aplicacaoPalavras) {
  if (aplicacaoPalavras.has(token)) return true;
  const grupo = _aliasMarcaIndex.get(token);
  if (!grupo) return false;
  return grupo.some(alias => aplicacaoPalavras.has(alias));
}

function _carregarIndices() {
  let arquivos;
  try {
    arquivos = fs.readdirSync(DIR_CATALOGO).filter(f => f.endsWith(".json"));
  } catch (e) {
    console.error("[catalogo-x2.service] pasta catalogo-x2 não encontrada:", e.message);
    return;
  }

  for (const arquivo of arquivos) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(DIR_CATALOGO, arquivo), "utf-8"));
    } catch (e) {
      console.error(`[catalogo-x2.service] falha ao ler ${arquivo}:`, e.message);
      continue;
    }
    for (const p of data) _indexarProduto(p);
  }

  console.log(
    `[catalogo-x2.service] índice pronto: ${totalProdutosIndexados} produtos, ` +
    `${equivalenteIndex.size} códigos equivalentes, ${produtosComAplicacao.length} com aplicação/veículo ` +
    `(${todosProdutos.length - produtosComAplicacao.length} sem aplicação, navegáveis só por Seção/Linha), ` +
    `${fabricanteCount.size} fabricantes distintos identificados.`
  );
}

_carregarIndices();

// Só entram no dropdown de filtro os fabricantes com um mínimo de produtos
// (>=5) — corta ruído residual do parsing (ex: valores que passaram pelo
// filtro de ruído mas são só ocorrências raras/erros de digitação isolados)
// sem esconder marcas reais pequenas da loja.
const FABRICANTE_MIN_OCORRENCIAS = 5;
const fabricantesDisponiveis = [...fabricanteCount.entries()]
  .filter(([, contagem]) => contagem >= FABRICANTE_MIN_OCORRENCIAS)
  .map(([nome]) => nome)
  .sort((a, b) => a.localeCompare(b, "pt-BR"));

// Palavras que vêm dos nomes das 26 seções (ex: "motor", "partida",
// "alternador", "injecao", "eletronica") — nunca servem de sinal de
// veículo, porque o texto de aplicação quase sempre cita o termo mecânico
// da própria peça (ex: "...COM MOTOR MWM..." aparece em qualquer produto
// mecânico, de caminhão a carro de passeio). Achado ao vivo em 2026-07-21:
// "motor de partida pro corolla 2015" bateu num motor de ônibus só porque
// "motor" aparecia no texto de aplicação — sem nenhuma relação com Corolla.
const PALAVRAS_CATEGORIA = new Set(
  [...secoesConhecidas.values()].flatMap(secao => _normalizar(secao).split(" "))
    .filter(w => w.length >= 3)
    .map(w => w.toLowerCase())
);

// ─── Fabricante da peça (Task #250-252, pedido do usuário em 2026-07-23) ──
function listarFabricantes() {
  return fabricantesDisponiveis;
}

// ─── Busca direta por código de fabricante/referência/código interno
// (Task #250-252, pedido do usuário em 2026-07-23) — diferente de
// buscarPorCodigoOriginal (abaixo), que extrai candidatos de uma mensagem em
// texto livre; aqui o atendente já digitou o código isolado num campo do
// painel, então pula a heurística de extração e consulta os índices direto.
// Aceita 3 tipos de entrada: código interno da loja (p.codigo), referência
// própria do fabricante (ficha.referencia) ou um código equivalente/OEM
// cadastrado — os 3 já têm índice pronto.
// Resolve um código equivalente/OEM para o produto de VERDADE cadastrado no
// catálogo (se X2 também vender essa peça, seja com esse código como
// código interno ou como referência/código de fornecedor). Pedido do
// usuário (2026-07-30): no painel "Ver referências", cada código
// equivalente deveria mostrar um card completo (foto + nome + barras +
// fornecedor) igual ao cartão do produto principal — não só o código cru.
// A maioria dos códigos equivalentes é de fabricante que a loja NÃO
// revende (por isso fica null e o frontend cai pro chip simples), mas
// quando a loja também vende aquela peça (ex: outra linha do catálogo com
// o mesmo código como referência), mostramos o card cheio.
function _resolverEquivalente(codigoBruto) {
  const norm = _normalizarCodigo(codigoBruto);
  if (!norm) return null;
  if (produtosPorCodigoIndex.has(norm)) return produtosPorCodigoIndex.get(norm);
  if (referenciaIndex.has(norm)) return referenciaIndex.get(norm);
  return null;
}

// Formato exposto ao frontend: { qtd, unidade, precoVarejo, precoAtacado }
// ou null (sem dado de estoque pra esse código — a maioria dos ~17.400
// produtos do catálogo, já que o Relatório de Estoque cobre só ~5.200).
// custoMedio fica de fora de propósito (preço de custo não deve aparecer
// pro atendente na tela de venda).
function _anexarEstoque(codigo) {
  const info = estoqueService.obterEstoque(codigo);
  if (!info) return null;
  return {
    qtd: info.qtdEstoque,
    unidade: info.unidade,
    precoVarejo: info.precoVendaVarejo,
    precoAtacado: info.precoVendaAtacado,
  };
}

function _detalharEquivalentes(equivalentes) {
  if (!equivalentes || !equivalentes.length) return [];
  return equivalentes.map(codigoBruto => {
    const resolvido = _resolverEquivalente(codigoBruto);
    return {
      codigo: codigoBruto,
      produto: resolvido ? {
        codigo: resolvido.codigo,
        nome: resolvido.nome,
        barras: resolvido.barras || null,
        referencia: resolvido.referencia || null,
      } : null,
    };
  });
}

function buscarPorCodigo(codigoBruto, { limite = 30 } = {}) {
  const codigo = _normalizarCodigo(codigoBruto);
  // Sem mínimo de tamanho artificial: a busca é por igualdade exata num Map
  // (não substring/scan), então não tem custo nem risco de match largo
  // demais — um código de 1-2 letras só "acha" algo se existir de verdade um
  // produto com código interno exatamente assim (nunca acontece no catálogo
  // real, onde código interno é sempre numérico e longo).
  if (!codigo) return [];

  const codigosInternos = new Set();
  for (const item of (equivalenteIndex.get(codigo) || [])) {
    codigosInternos.add(_normalizarCodigo(item.codigo));
  }
  if (referenciaIndex.has(codigo)) codigosInternos.add(_normalizarCodigo(referenciaIndex.get(codigo).codigo));
  if (produtosPorCodigoIndex.has(codigo)) codigosInternos.add(codigo);

  const resultado = [];
  for (const cod of codigosInternos) {
    const item = produtosPorCodigoIndex.get(cod);
    if (!item) continue;
    resultado.push({
      codigo: item.codigo,
      nome: item.nome,
      secao: item.secao,
      linha: item.linha,
      referencia: item.referencia,
      fabricante: item.fabricante,
      aplicacao: item.aplicacao,
      equivalentes: item.equivalentes || [],
      equivalentesDetalhados: _detalharEquivalentes(item.equivalentes),
      referenciasCruzadas: item.referenciasCruzadas || null,
      barras: item.barras || null,
      marcaCompativel: false,
      anoCompativel: false,
      estoque: _anexarEstoque(item.codigo),
    });
    if (resultado.length >= limite) break;
  }
  return resultado;
}

// ─── Busca por código original/equivalente (Task #216) ────────────────────
function buscarPorCodigoOriginal(texto, { limite = 5 } = {}) {
  const candidatos = _extrairCodigosDoTexto(texto);
  if (!candidatos.length) return [];

  const encontrados = [];
  const vistos = new Set();
  for (const codigo of candidatos) {
    const porEquivalente = equivalenteIndex.get(codigo) || [];
    const porReferencia  = referenciaIndex.has(codigo) ? [referenciaIndex.get(codigo)] : [];
    for (const item of [...porEquivalente, ...porReferencia]) {
      if (vistos.has(item.codigo)) continue;
      vistos.add(item.codigo);
      encontrados.push(item);
      if (encontrados.length >= limite) return encontrados;
    }
  }
  return encontrados;
}

// ─── Busca por veículo compatível (Task #215) ──────────────────────────────
// linhasCandidatas: resultado de catalogo.service.buscarNoCatalogo(mensagem)
// — restringe a busca à(s) linha(s) específicas já confirmadas na mensagem
// (ex: "alternador completo"). Na prática o cliente quase sempre cita só a
// categoria geral ("alternador", "motor de partida"), que não bate com
// nenhuma linha específica do catalogo-produtos.json (essas são sub-peças:
// "ALTERNADOR COMPLETO", "ROTOR", etc.) — por isso, sem linha candidata,
// cai pra checar se o nome de alguma das 26 SEÇÕES do X2 aparece na
// mensagem, e restringe por seção inteira nesse caso.
// Palavras curtas (>=3 letras) comuns demais em português pra servirem de
// sinal de veículo — sem isso, "tem" bate como substring dentro de "TEMPRA"
// e gera falso positivo (achado ao vivo em 2026-07-21: mensagem sobre
// Ferrari retornou peça pra Fiat só por causa de "tem"/"pra").
const STOPWORDS_VEICULO = new Set([
  "tem", "tém", "têm", "pra", "pro", "para", "com", "uma", "um", "dos", "das",
  "que", "voce", "voces", "vcs", "tenho", "precis", "preciso", "gostaria",
  "meu", "minha", "carro", "veiculo", "modelo", "ano", "tipo", "aquele", "aquela",
]);

function buscarPorVeiculo(mensagem, linhasCandidatas = [], { limite = 3 } = {}) {
  const msgNormalizada = _normalizar(mensagem);
  const tokens = msgNormalizada.split(" ")
    .filter(t => t.length >= 3 && !STOPWORDS_VEICULO.has(t.toLowerCase()) && !PALAVRAS_CATEGORIA.has(t.toLowerCase()));
  if (!tokens.length) return [];

  let secaoCandidata = null;
  if (!linhasCandidatas.length) {
    for (const [secaoNorm, secaoOriginal] of secoesConhecidas) {
      if (msgNormalizada.includes(secaoNorm)) { secaoCandidata = secaoOriginal; break; }
    }
  }

  // Sem sinal nenhum de categoria (nem linha específica, nem seção
  // reconhecida na mensagem) — não dá pra restringir a busca com segurança,
  // então não busca (evita cruzar veículo com produto de categoria
  // qualquer, que já causou falso positivo — ver STOPWORDS_VEICULO acima).
  if (!linhasCandidatas.length && secaoCandidata === null) return [];

  // Dentro de uma seção (sem linha específica), muitas seções decompõem o
  // produto em sub-peças (ex: ALTERNADOR tem "ALOJAMENTO", "ROTOR",
  // "ESCOVA" além de "ALTERNADOR COMPLETO"). Se existir alguma linha
  // "completo/completa" entre os candidatos, prioriza só essas — cliente
  // que pede "um alternador" quer a peça inteira, não um rolamento avulso.
  const candidatosSecao = secaoCandidata !== null
    ? produtosComAplicacao.filter(p => p.secao === secaoCandidata)
    : null;
  const temLinhaCompleta = candidatosSecao?.some(p => /complet[ao]/i.test(p.linha));

  const minMatches = tokens.length >= 2 ? 2 : 1;
  const encontrados = [];
  for (const p of produtosComAplicacao) {
    const bateLinha = linhasCandidatas.some(l => l.secao === p.secao && l.linha === p.linha);
    const bateSecao = secaoCandidata !== null && p.secao === secaoCandidata
      && (!temLinhaCompleta || /complet[ao]/i.test(p.linha));
    if (!bateLinha && !bateSecao) continue;

    // Palavra inteira, não substring — "GOL" não deve bater dentro de
    // "GOLF" (achado ao vivo em 2026-07-21). _tokenBateAplicacao também
    // aceita sinônimos de marca conhecidos (GM/General Motors/Chevrolet —
    // ver GRUPOS_ALIAS_MARCA acima).
    const matches = tokens.filter(t => _tokenBateAplicacao(t, p.aplicacaoPalavras)).length;
    // PEDIDO DO USUÁRIO (2026-07-27): peça Universal/Diversos (ver flag
    // `universal` em _indexarProduto) serve pra qualquer veículo da mesma
    // categoria/linha já confirmada (bateLinha/bateSecao acima) — entra
    // mesmo sem bater nenhum token do veículo pesquisado.
    if (matches >= minMatches || p.universal) {
      encontrados.push(p);
      if (encontrados.length >= limite) break;
    }
  }
  return encontrados;
}

// ─── Busca estruturada pro painel "Catálogo de Produtos" (atendente digita
// marca/modelo/ano/categoria, sem depender de mensagem livre de cliente) ───
//
// Diferente de buscarPorVeiculo (acima), que exige uma linha/seção já
// conhecida pela mensagem do cliente antes de buscar: aqui a categoria é só
// mais um filtro OPCIONAL (decisão do usuário, 2026-07-21) — sem ela, a
// busca varre todas as seções.
//
// Modelo é tratado como o token OBRIGATÓRIO (quando informado): é o dado mais
// confiável no catálogo real, quase sempre citado. Marca é frequentemente
// omitida no texto quando o modelo já deixa a marca óbvia (ex: aplicação diz
// só "Astra Hatch 1998 > 2011", sem repetir "GM") — por isso marca vira
// exigência só quando não há modelo pra usar, e quando marca E modelo são
// informados, marca funciona como reforço de ranking (marcaCompativel),
// nunca como filtro de exclusão. Ano segue a mesma lógica (ver
// _anoCompativel acima).
function buscarProdutosPainel({ marca = "", modelo = "", ano = null, categoria = "", fabricante = "", limite = 200 } = {}) {
  const marcaTokens  = _tokens(marca);
  const modeloTokens = _tokens(modelo);
  const anoNum = ano ? Number(ano) : null;
  const categoriaNorm = categoria && String(categoria).trim() ? _normalizar(categoria) : null;
  // Fabricante é filtro por igualdade exata (não substring) — vem sempre do
  // dropdown já normalizado por listarFabricantes(), não de texto livre.
  const fabricanteNorm = fabricante && String(fabricante).trim() ? String(fabricante).trim().toUpperCase() : null;

  // Modo NAVEGAÇÃO: nenhum veículo informado, só Seção/Linha e/ou Fabricante
  // — usado pelo dropdown do painel pra listar o catálogo inteiro daquela
  // categoria/marca, incluindo os ~1.900 produtos sem texto de
  // aplicação/veículo (peças genéricas: abraçadeira, parafuso etc.) que o
  // modo de busca por veículo abaixo nunca alcançaria, já que não tem o que
  // cruzar. Pedido do usuário (2026-07-22): o painel precisa dar acesso ao
  // banco de dados inteiro (config/catalogo-x2), não só à fatia com
  // aplicação cadastrada. Fabricante entrou no mesmo modo em 2026-07-23
  // (pedido do usuário): filtrar só por marca da peça, sem veículo nenhum,
  // é um caso de uso tão válido quanto navegar só por Seção/Linha.
  if (!marcaTokens.length && !modeloTokens.length) {
    if (!categoriaNorm && !fabricanteNorm) return { total: 0, produtos: [] };

    const encontrados = todosProdutos.filter(p => {
      if (categoriaNorm) {
        const secaoNorm = _normalizar(p.secao);
        const linhaNorm = _normalizar(p.linha);
        if (!secaoNorm.includes(categoriaNorm) && !linhaNorm.includes(categoriaNorm)) return false;
      }
      if (fabricanteNorm && (!p.fabricante || p.fabricante.toUpperCase() !== fabricanteNorm)) return false;
      return true;
    });

    encontrados.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    const total = encontrados.length;
    const produtos = encontrados.slice(0, limite).map(p => ({
      codigo: p.codigo,
      nome: p.nome,
      secao: p.secao,
      linha: p.linha,
      referencia: p.referencia,
      fabricante: p.fabricante,
      aplicacao: p.aplicacao,
      equivalentes: p.equivalentes || [],
      equivalentesDetalhados: _detalharEquivalentes(p.equivalentes),
      referenciasCruzadas: p.referenciasCruzadas || null,
      barras: p.barras || null,
      marcaCompativel: false,
      anoCompativel: false,
      estoque: _anexarEstoque(p.codigo),
    }));

    return { total, produtos };
  }

  // Pedido do usuário (2026-07-31, investigado a fundo): busca por "Ford" +
  // "Uno" (combinação que não existe — Uno é Fiat) retornou 883 peças,
  // porque só o Modelo é obrigatório aqui; Marca só entra depois pra
  // ranquear (ver marcaCompativel abaixo), nunca pra excluir. Perguntei se
  // fazia sentido exigir os dois batendo juntos — a resposta é NÃO, e tem
  // prova concreta: o produto 109592 ("ROTOR ALT. ESCORT,UNO,DUNA,MWM,
  // UNIVERSAL") serve de verdade num Fiat Uno, mas o texto de aplicação
  // dele (copiado cru do ERP da X2, sem estrutura fixa) é só "Escort, Uno,
  // Duna, MWM, Universal, Ford, Jonh Deere, MB" — a palavra "Fiat" NUNCA
  // aparece ali. Exigir Marca+Modelo juntos resolveria o caso Ford+Uno mas
  // cortaria peça de verdade como essa em qualquer busca "Fiat"+"Uno".
  // Decisão do usuário: manter só Modelo obrigatório (like estava) — o
  // ganho de não perder peça de verdade pesa mais que o ruído ocasional de
  // uma combinação marca+modelo inexistente trazer resultado demais.
  const tokensObrigatorios = modeloTokens.length ? modeloTokens : marcaTokens;
  const minMatches = tokensObrigatorios.length >= 2 ? 2 : 1;

  const encontrados = [];
  for (const p of produtosComAplicacao) {
    if (categoriaNorm) {
      const secaoNorm = _normalizar(p.secao);
      const linhaNorm = _normalizar(p.linha);
      if (!secaoNorm.includes(categoriaNorm) && !linhaNorm.includes(categoriaNorm)) continue;
    }
    if (fabricanteNorm && (!p.fabricante || p.fabricante.toUpperCase() !== fabricanteNorm)) continue;

    // _tokenBateAplicacao aceita sinônimos de marca conhecidos (GM/General
    // Motors/Chevrolet — ver GRUPOS_ALIAS_MARCA acima).
    const matchesObrigatorios = tokensObrigatorios.filter(t => _tokenBateAplicacao(t, p.aplicacaoPalavras)).length;
    // PEDIDO DO USUÁRIO (2026-07-27): peça Universal/Diversos entra mesmo
    // sem bater nenhum token de marca/modelo, DESDE QUE uma categoria tenha
    // sido informada (já filtrada acima) — sem categoria, ficaria de fora
    // pra não poluir a busca com peça genérica demais (ver comentário na
    // flag `universal`, _indexarProduto).
    const universalRelevante = p.universal && !!categoriaNorm;
    if (!universalRelevante && matchesObrigatorios < minMatches) continue;

    const marcaCompativel = marcaTokens.length ? marcaTokens.some(t => _tokenBateAplicacao(t, p.aplicacaoPalavras)) : false;
    const anoCompativel = _anoCompativel(p.faixasAno, anoNum);

    encontrados.push({ p, matchesObrigatorios, marcaCompativel, anoCompativel });
  }

  // Ordena: ano compatível primeiro, depois marca compatível, depois quantos
  // tokens obrigatórios bateram — tudo isso é ranking, não exclusão. Por
  // último, desempata por especificidade (menos palavras no texto de
  // aplicação = lista de veículos mais curta/específica): sem isso, uma
  // "PALHETA UNIVERSAL" com um texto de aplicação gigante (centenas de
  // modelos citados, achado ao vivo em 2026-07-21) empata em critérios
  // acima com uma peça específica pro veículo buscado e pode ficar na
  // frente por ordem arbitrária de índice.
  encontrados.sort((a, b) => {
    if (a.anoCompativel !== b.anoCompativel) return a.anoCompativel ? -1 : 1;
    if (a.marcaCompativel !== b.marcaCompativel) return a.marcaCompativel ? -1 : 1;
    if (a.matchesObrigatorios !== b.matchesObrigatorios) return b.matchesObrigatorios - a.matchesObrigatorios;
    return a.p.aplicacaoPalavras.size - b.p.aplicacaoPalavras.size;
  });

  const total = encontrados.length;
  const produtos = encontrados.slice(0, limite).map(({ p, marcaCompativel, anoCompativel }) => ({
    codigo: p.codigo,
    nome: p.nome,
    secao: p.secao,
    linha: p.linha,
    referencia: p.referencia,
    fabricante: p.fabricante,
    aplicacao: p.aplicacao,
    equivalentes: p.equivalentes || [],
    equivalentesDetalhados: _detalharEquivalentes(p.equivalentes),
    referenciasCruzadas: p.referenciasCruzadas || null,
    barras: p.barras || null,
    marcaCompativel,
    anoCompativel,
    estoque: _anexarEstoque(p.codigo),
  }));

  return { total, produtos };
}

module.exports = {
  buscarPorCodigoOriginal,
  buscarPorVeiculo,
  buscarProdutosPainel,
  buscarPorCodigo,
  listarFabricantes,
};
