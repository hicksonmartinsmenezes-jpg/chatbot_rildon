/**
 * catalogo-x2.service.js — busca estruturada sobre o banco de produtos X2
 * (src/config/catalogo-x2/*.json), extraído do ERP da loja em 2026-07-20 e
 * parseado (campo "ficha") em 2026-07-20.
 *
 * Por que existe: catalogo.service.js já dá à IA confirmação de Seção/Linha
 * ("a loja tem ALTERNADOR"), mas não sabe dizer se um alternador específico
 * SERVE pra um veículo, nem cruzar um código de peça original (OEM) com o
 * produto equivalente cadastrado. Este serviço expõe três buscas de alta
 * precisão sobre os ~17.400 produtos com ficha técnica parseada:
 *
 *   1. buscarPorCodigoOriginal(texto) — acha token(s) na mensagem que
 *      parecem código de peça e retorna o(s) produto(s) cadastrados, cruzando
 *      os 3 tipos de código que a loja usa: número original/OEM de terceiros
 *      (equivalenteIndex), código de referência do próprio fabricante da
 *      peça (referenciaIndex) e código interno da loja (produtosPorCodigo
 *      Index) — pedido do usuário em 2026-08-14 pra o bot reconhecer os 3.
 *      Match exato, sem ambiguidade — seguro pra afirmar com confiança.
 *   2. buscarPorVeiculo(mensagem, linhasCandidatas) — dado um recorte de
 *      linhas candidatas (normalmente já vindo de catalogo.service
 *      .buscarNoCatalogo, que garante a categoria certa), cruza os tokens
 *      da mensagem do cliente com o texto de "Aplicação" (veículos
 *      compatíveis) de cada produto daquela linha. Propositalmente exige
 *      >=2 tokens batendo (ou o único token, se só houver um) — 1 palavra
 *      solta bate por acaso demais pra ser confiável.
 *   3. buscarPorNomeProduto(texto) — pedido do usuário em 2026-08-14
 *      ("alimentar o bot com todo o banco de dados da loja"): cruza os
 *      tokens da mensagem direto contra o NOME REAL de cada um dos 17.520
 *      produtos (não só as 397 linhas genéricas de catalogo.service.js),
 *      cobrindo peça descrita de um jeito que não bate exatamente com
 *      nenhuma linha cadastrada. Mesma exigência de >=2 tokens batendo.
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
// PEDIDO DO USUÁRIO (2026-09-04, referência do concorrente KKI Vendas):
// anexa a versão já reorganizada pela IA (ver organizarAplicacaoIA em
// ai.service.js) quando já estiver em CACHE — melhora a tabela de aplicação
// do modal de detalhe (formato mais uniforme "FABRICANTE: modelos" que o
// texto cru do X2) sem custar nada (só leitura, síncrona, de um Map em
// memória). Nunca dispara chamada de IA nova aqui — isso só acontece nos
// fluxos de PDF, de propósito, pra não gastar crédito a cada busca do painel.
//
// Require ADIADO (não no topo do arquivo): catalogo-aplicacao-ia.service.js
// exige ai.service.js, que por sua vez exige ESTE arquivo
// (buscarPorCodigoOriginal/buscarPorVeiculo/buscarPorNomeProduto) — um
// require direto aqui no topo cria dependência circular de verdade, e se
// catalogo-x2.service.js for o primeiro módulo carregado na cadeia de boot,
// ai.service.js pega um module.exports ainda vazio (undefined nas 3
// funções). Adiar o require pra dentro da função só resolve na 1ª chamada
// real (depois que todo o boot já terminou), sem esse risco.
let _obterAplicacaoOrganizadaCache = null;
function _aplicacaoOrganizadaCache(texto) {
  if (!_obterAplicacaoOrganizadaCache) {
    _obterAplicacaoOrganizadaCache = require("./catalogo-aplicacao-ia.service").obterAplicacaoOrganizadaCache;
  }
  return _obterAplicacaoOrganizadaCache(texto);
}

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
  // BUG REAL achado 2026-09-01 (testando import do Catálogo Promocional com
  // arquivo real do usuário, "Wega Estoque.xlsx"): produto "ELEMENTO
  // FILTRANTE DE CABINE PEUGEOT 207/ 206/ HOGGAR- WEGA - AKX35157" (código
  // 123621) tem "WEGA" bem ali no nome, mas caía em "Sem fabricante
  // identificado" — o separador " - " (espaço-hífen-espaço) que o parsing
  // exige tinha um typo de cadastro no X2 (falta espaço ANTES do hífen:
  // "HOGGAR- WEGA" em vez de "HOGGAR - WEGA"), então o split(" - ") virava
  // 2 blocos em vez de 3. Escaneando o catálogo inteiro (23.475 produtos,
  // 2026-09-01) esse mesmo padrão de typo afeta 207 produtos reais
  // (fabricantes válidos como FRONTEC/TIGER/SEG/BOSCH/GAUSS/IKRO ficando
  // ocultos) — zero regressão nos que já tinham fabricante certo. Fix:
  // normaliza o hífen "colado" ANTES de splitar — só insere espaço quando o
  // hífen já tem espaço DEPOIS mas não ANTES. Nunca mexe em hífen de código
  // composto (ex: "AKX1445-2", "FAP4054/2"), que não têm espaço nenhum ao
  // redor — continuam sem fabricante identificado, como já era o caso.
  const normalizado = String(nome || "").replace(/(?<=\S)-(?=\s)/g, " -");
  const partes = normalizado.split(" - ");
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

// PEDIDO DO USUÁRIO (2026-09-04): "algumas aplicações podem aparecer também
// nas descrições" — vários produtos sem `ficha.aplicacao` preenchida têm a
// marca do veículo/máquina compatível já citada no PRÓPRIO NOME (ex: "FILTRO
// DE OLEO FORD FIESTA 1.6 96/02"), mas ficavam 100% fora de busca por
// veículo e caíam em "Outras Aplicações" no Catálogo Completo por causa
// disso. Esta lista NÃO foi inventada à mão — foi extraída escaneando os
// textos de `ficha.aplicacao` REAIS já cadastrados em todo o catálogo
// (~14.183 produtos com aplicação preenchida), pegando o token antes do
// primeiro ":" de cada segmento separado por ";" (ex: "FORD: FIESTA 1.6
// 96/02;" -> "FORD") e contando frequência — só entrou marca com 2+
// ocorrências reais no catálogo, e depois de filtrar manualmente ruído de
// regex (palavras genéricas tipo "ALTERNADOR", "DIVERSOS", "VEICULOS
// IMPORTADOS" que também caem nesse formato mas não são marca nenhuma).
// Guarda só PALAVRA INTEIRA (não substring) pelo mesmo motivo documentado
// acima em GRUPOS_ALIAS_MARCA (GOL/GOLF) — comparação é sempre contra
// _normalizar(nome).split(" "), nunca .includes() de string crua.
const MARCAS_VEICULO_CONHECIDAS = new Set([
  "FORD", "FIAT", "VW", "GM", "MERCEDES", "RENAULT", "VOLKSWAGEN", "VOLKSWAGEM",
  "CHEVROLET", "TOYOTA", "HYUNDAI", "AUDI", "AGRALE", "CITROEN", "CASE",
  "VOLVO", "SCANIA", "HONDA", "IVECO", "MITSUBISHI", "NISSAN", "KIA",
  "CATERPILLAR", "SEAT", "CUMMINS", "CHERY", "PEUGEOT", "MB", "MBB", "BMW",
  "CHRYSLER", "MAXION", "VALMET", "OPEL", "DEUTZ", "DEERE", "ATLAS", "COPCO",
  "BOBCAT", "DAEWOO", "EATON", "GURGEL", "MF", "MWM", "PORSCHE", "HYSTER",
  "ISUZU", "KOMATSU", "CLARK", "VALTRA", "DAIHATSU", "AGCO", "JEEP", "SUZUKI",
  "ROVER", "DODGE", "SSANGYONG", "SKODA", "LIFAN", "MAFERSA", "PERKINS",
  "LEXUS", "MAZDA", "DAF", "INFINITI", "BELL", "CARRIER", "JCB", "FARYMANN",
  "JAC", "BOMAG", "TEREX", "MAN", "EFFA", "BOSCH", "FREIGHTLINER", "VAUXHALL",
  "LADA", "TROLLER", "JAGUAR", "ALFA", "ROMEO", "WILLYS", "HOLLAND", "MASSEY",
  "FERGUSON", "ASIA", "ACURA",
]);

function _contemMarcaConhecida(nomeNormalizado) {
  if (!nomeNormalizado) return false;
  for (const palavra of nomeNormalizado.split(" ")) {
    if (MARCAS_VEICULO_CONHECIDAS.has(palavra)) return true;
  }
  return false;
}

// PEDIDO DO USUÁRIO (2026-09-04, referência do concorrente KKI Vendas): a
// aba "Critérios de Pesquisa" do painel ganhou um campo "Montadora" com
// sugestões — em vez de inventar uma lista à parte, reaproveita a MESMA
// MARCAS_VEICULO_CONHECIDAS já validada contra dado real do catálogo (ver
// comentário acima). Ordenada pra exibição no <datalist> do frontend.
function listarMarcasVeiculoConhecidas() {
  return [...MARCAS_VEICULO_CONHECIDAS].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function _indexarProduto(p) {
  // BUG REAL corrigido (2026-08-13, achado testando ao vivo busca por
  // código original no painel: "F00M111601" devolvia card com estoque/
  // preço certos mas SEM nome/seção/fabricante/aplicação nenhum). Causa:
  // src/config/catalogo-x2/cod-fornecedor.json não é um arquivo de
  // catálogo de produto — é uma lista de mapeamento {cod_fornecedor,
  // codigo} usada só por catalogo-pdf.service.js, sem nome/seção/ficha
  // nenhuma. Como ele mora na mesma pasta dos *.json de produto de
  // verdade, o loop genérico de _carregarIndices() (readdirSync + filter
  // ".json") também tentava indexar cada item dele como se fosse produto
  // — sobrescrevendo em produtosPorCodigoIndex a entrada completa (vinda
  // de alternador.json etc, carregado antes em ordem alfabética) por um
  // stub vazio, pro mesmo código. Guarda dupla: exclusão explícita do
  // arquivo em _carregarIndices() (fix principal) + este early-return
  // aqui (defesa extra — nenhum registro de produto de verdade tem
  // `nome` vazio, então não afeta indexação legítima nenhuma).
  if (!p.nome) return;

  // BUG REAL corrigido (2026-08-13, achado testando ao vivo o reload do
  // catálogo): produtos com `ficha: null` (todo produto novo entra assim
  // desde 2026-07-28, decisão consciente — ver x2-catalogo-sync.js) eram
  // pulados INTEIRAMENTE aqui, inclusive do `produtosPorCodigoIndex`
  // (usado por buscarPorCodigo, que só precisa de `p.codigo` — nem usa
  // ficha nenhuma). Isso contradizia a decisão documentada de que "o
  // restante do sistema já trata isso como sem ficha disponível": na
  // prática, 122 produtos (confirmado em 2026-08-13, todos os catálogo-x2/
  // *.json) ficaram gravados no disco mas 100% invisíveis em qualquer busca
  // do painel de atendimento desde que entraram. `ficha || {}` mantém o
  // produto indexado (código, nome, seção/linha, navegação) e só deixa de
  // preencher os campos que dependem da ficha (aplicação, equivalentes,
  // referências cruzadas) — exatamente o comportamento pretendido.
  const ficha = p.ficha || {};

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
  const nomeNormalizado = _normalizar(p.nome);
  const base = {
    codigo: p.codigo, nome: p.nome, secao: p.secao, linha: p.linha,
    referencia: ficha.referencia || null, fabricante,
    equivalentes, referenciasCruzadas,
    // BUG REAL corrigido 2026-09-04 (usuário reportou aba "Especificação
    // Técnica" do modal sempre vazia, mesmo com dado real no X2 — ex:
    // AMPERIMETRO 30.304-12M tem "3. Dados Técnicos: 50A TAMANHO: 52MM" no
    // X2): ficha.dadosTecnicos nunca tinha sido incluído em `base`, então
    // nenhuma busca (buscarPorCodigo/buscarPorNomePainel/buscarProdutosPainel)
    // devolvia esse campo pro painel — a aba estava com um texto FIXO de
    // "sem dados" no frontend, não checava dado nenhum de verdade.
    dadosTecnicos: ficha.dadosTecnicos || null,
    // Código de barras (pedido do usuário, 2026-07-30): usado no cabeçalho
    // do painel "Ver referências", que reproduz o mesmo cartão visual da
    // tela "Equivalentes" do X2 (Código Produto / Código Barras / Código
    // Fornecedor). Já vinha no JSON bruto (p.barras), só não estava
    // indexado pra nenhum uso anterior.
    barras: p.barras || null,
    // PEDIDO DO USUÁRIO (2026-08-14): "alimentar o bot com todo o banco de
    // dados da loja" — usado por buscarPorNomeProduto pra confirmar peça
    // pelo NOME REAL do produto (não só pelas 397 linhas genéricas de
    // catalogo.service.js). Set de PALAVRAS INTEIRAS (não substring) —
    // pré-computado aqui (não a cada mensagem, roda contra ~17.520
    // produtos). Substring já causou falso positivo real neste mesmo
    // arquivo antes (ver GOL/GOLF em buscarPorVeiculo) — aqui apareceu de
    // novo ao testar: "bom dia" batia em "BOMB..." e "...DIANT..." por
    // conter "BOM"/"DIA" como substring. Set de palavras inteiras evita.
    nomePalavras: new Set(nomeNormalizado.split(" ")),
    // PEDIDO DO USUÁRIO (2026-08-14): "gostaria que no meu painel de
    // catálogo também tivesse opção de pesquisar por peça nome" — usado por
    // buscarPorNomePainel (busca por SUBSTRING, diferente de nomePalavras
    // acima que exige palavra INTEIRA — aqui o atendente busca de propósito
    // por nome, então uma palavra parcial como "alternad" deve achar
    // "ALTERNADOR" normalmente). Guardar a string já normalizada evita
    // normalizar o nome de novo a cada busca (roda contra ~17.520 produtos
    // por submit do formulário).
    nomeNormalizado,
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
    // BUG REAL achado 2026-09-01 testando import de preço com "Wega
    // Estoque.xlsx" real (FCD0721/FCD0727 sumindo de busca por código e do
    // Catálogo Promocional): mesmo typo de digitação do X2 já corrigido em
    // _extrairFabricante — hífen sem espaço antes ("FCD-0721- WEGA",
    // "FCD0727- WEGA" em vez de "FCD0721 - WEGA"/"FCD0727 - WEGA") fazia
    // `.includes(" - ")` falhar, então refCodigoParte ficava com o "- WEGA"
    // grudado e _normalizarCodigo produzia "FCD0721WEGA"/"FCD0727WEGA" —
    // nunca batendo com o código "FCD0721"/"FCD0727" do arquivo de preço.
    // Normaliza o hífen ANTES de checar/splitar em " - ", mesma técnica.
    const referenciaNormalizada = ficha.referencia.replace(/(?<=\S)-(?=\s)/g, " -");
    const refCodigoParte = referenciaNormalizada.includes(" - ") ? referenciaNormalizada.split(" - ")[0] : referenciaNormalizada;
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
  } else if (_contemMarcaConhecida(nomeNormalizado)) {
    // Fallback (pedido do usuário, 2026-09-04): sem `ficha.aplicacao`, mas o
    // NOME do produto já cita uma marca de veículo/máquina conhecida (ver
    // MARCAS_VEICULO_CONHECIDAS acima) — usa o próprio nome como texto de
    // aplicação, com o MESMO tratamento do bloco acima (palavras/faixa de
    // ano), pra passar a valer tanto na busca por veículo do painel quanto
    // no agrupamento por marca do Catálogo Completo/organizarAplicacaoIA
    // (antes caía direto em "Outras Aplicações", mesmo já tendo a marca
    // escrita ali no nome).
    const aplicacaoNormalizada = nomeNormalizado;
    const aplicacaoPalavras = new Set(aplicacaoNormalizada.split(" "));
    item = {
      ...base,
      aplicacao: p.nome,
      aplicacaoNormalizada,
      aplicacaoPalavras,
      faixasAno: _extrairFaixasDeAno(p.nome),
      universal: false,
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

// PEDIDO DO USUÁRIO (2026-09-04, referência KKI Vendas): campo único "Ano"
// virou "Ano Inicial"/"Ano Final" (faixa) no painel — estende a assinatura
// pra aceitar uma faixa buscada, checando INTERSEÇÃO com a faixa do produto
// em vez de um ano exato. Quando só `anoInicio` é passado (uso antigo,
// buscarPorNomePainel/rotas legadas), `anoFim` cai pro mesmo valor e o
// resultado é IDÊNTICO ao comportamento anterior — mesma matemática, só
// que anoBuscado passa a se chamar anoInicio===anoFim. Continua sendo
// critério de RANKING, nunca de exclusão (mesma decisão documentada acima
// em buscarProdutosPainel: produto sem ano cadastrado nunca é cortado).
function _anoCompativel(faixas, anoInicio, anoFim = null) {
  const buscaInicio = anoInicio || anoFim;
  const buscaFim = anoFim || anoInicio;
  if (!buscaInicio || !faixas || !faixas.length) return false;
  return faixas.some(f => {
    const fimFaixa = f.fim === null ? Infinity : f.fim;
    return buscaInicio <= fimFaixa && buscaFim >= f.inicio;
  });
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

// Arquivos em catalogo-x2/ que NÃO são catálogo de produto (mapeamentos
// auxiliares usados por outro serviço) — ver comentário longo em
// _indexarProduto sobre o bug real que isso causou em 2026-08-13.
// BUG REAL corrigido em 2026-08-27: aplicacao-ia-cache.json (Issue #23,
// cache de texto de "aplicação" já organizado pela IA — ver
// catalogo-aplicacao-ia.service.js) mora no MESMO diretório mas é um
// objeto hash→texto, não um array de produtos. Assim que o arquivo passou
// a existir de verdade (1º export real do Catálogo Completo que cacheou
// algo), _carregarIndices tentava iterar esse objeto com `for...of` e
// derrubava o boot inteiro do bot com "TypeError: data is not iterable" —
// mesma classe de bug do cod-fornecedor.json em 2026-08-13, mesmo fix.
// 2026-09-02: fotos-preferencias.json (Catálogo — trocar foto principal
// manualmente, catalogo-fotos.service.js) entrou na lista pelo MESMO motivo
// dos dois de cima — mora no mesmo diretório, é um objeto código→nome de
// arquivo, não array de produtos. Reproduzido ao vivo: assim que o
// atendente usa a troca de foto pela 1ª vez, o arquivo passa a existir e a
// PRÓXIMA vez que o índice de produtos for (re)carregado (reiniciar o bot,
// ou POST /catalogo/produtos/recarregar) quebra com "TypeError: data is not
// iterable", igual aconteceu com os outros dois — o catálogo INTEIRO para
// de carregar, não só a foto.
// fotos-ocultas.json (2026-09-02, feature de ocultar foto) adicionado aqui
// de propósito — mesmo bug real já corrigido pra fotos-preferencias.json:
// esse loop varre TODO .json da pasta catalogo-x2/ achando que é um arquivo
// de produtos; qualquer JSON novo de config/estado que caia nessa mesma
// pasta tem que entrar nessa lista, senão quebra o catálogo inteiro.
const ARQUIVOS_NAO_PRODUTO = new Set(["cod-fornecedor.json", "aplicacao-ia-cache.json", "fotos-preferencias.json", "fotos-ocultas.json", "categoria-correcoes.json"]);

// PEDIDO DO USUÁRIO (2026-09-05, achado investigando M02051/M02038 sob a
// Linha errada "AMPERÍMETRO"): em vez de escrever um script de reparo
// cirúrgico cada vez que o X2 cadastra um produto na categoria errada
// (aconteceu de verdade, confirmado ao vivo contra o X2 — ver
// scripts/repair-linha-manometro-em-amperimetro.js), o atendente corrige
// direto no painel. Mesmo padrão NÃO-DESTRUTIVO já usado pra foto
// preferida/oculta (ver definirFotoPreferida/ocultarFoto em
// catalogo-fotos.service.js): a correção fica só num JSON à parte
// (categoria-correcoes.json), nunca sobrescreve o dado bruto do X2 nos
// arquivos de Seção — sobrevive a recarregar índice, a reinício do bot, e
// (diferente de editar o JSON de produto direto) sobrevive também ao caso
// raro de um código sumir e reentrar num resync futuro (x2-catalogo-sync.js
// nunca mexe em produto já existente, mas se o código for removido e depois
// recadastrado como "novo", uma edição direta no arquivo de produto se
// perderia; a correção aqui não, porque é indexada pelo próprio código).
// Escopo v1 (decisão do usuário): só o campo `linha` — não `secao` nem
// nenhum campo de `ficha` (aplicação/dadosTecnicos/equivalentes), que não
// têm fonte confiável pra corrigir sem risco (ver aviso em
// x2-catalogo-sync.js sobre dado errado em aplicação ser pior que não ter
// ficha nenhuma).
const CORRECOES_CATEGORIA_PATH = path.join(DIR_CATALOGO, "categoria-correcoes.json");

let correcoesCategoria = null; // Map<codigo, { linha }> — lazy, carregado do disco na 1ª chamada.

function _garantirCorrecoesCategoria() {
  if (correcoesCategoria) return correcoesCategoria;
  correcoesCategoria = new Map();
  try {
    const bruto = JSON.parse(fs.readFileSync(CORRECOES_CATEGORIA_PATH, "utf8"));
    for (const [codigo, correcao] of Object.entries(bruto)) {
      if (correcao && correcao.linha) correcoesCategoria.set(String(codigo), { linha: String(correcao.linha) });
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[catalogo-x2.service] falha ao ler categoria-correcoes.json:", e.message);
    }
  }
  return correcoesCategoria;
}

function _salvarCorrecoesCategoria() {
  const obj = Object.fromEntries(correcoesCategoria);
  fs.writeFileSync(CORRECOES_CATEGORIA_PATH, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// BUG REAL achado 2026-09-04 (usuário reportou produto após produto com
// aplicação/produtos similares vazios no modal do Catálogo "mesmo tendo tudo
// no sistema"): o MESMO código de produto aparece cadastrado em mais de um
// arquivo de seção — normalmente uma cópia "de casa" com `ficha` completa
// (aplicação/equivalentes/dados técnicos parseados) e uma cópia fantasma
// (mesmo nome, seção errada, `ficha: null`) sobrando em outro arquivo depois
// de alguma reorganização de seção no X2. Confirmado num scan completo dos 26
// arquivos: 7.702 códigos duplicados desse jeito — quase metade do catálogo.
// _carregarIndices() lia os arquivos em ORDEM ALFABÉTICA e cada _indexarProduto
// sobrescrevia produtosPorCodigoIndex sem checar nada — então sempre que a
// cópia vazia estava num arquivo que carregava DEPOIS da cópia boa (ordem
// alfabética, não tem nada a ver com qual é "mais nova"), ela apagava a boa
// da memória. Não é cache desatualizado — é bug de indexação, incondicional a
// reload/restart. Confirmado também que nos 7.702 casos reais NUNCA existem
// duas cópias com ficha preenchida ao mesmo tempo pro mesmo código — ou seja,
// escolher "a que tem ficha com conteúdo" nunca é ambíguo.
function _fichaTemConteudo(ficha) {
  if (!ficha || typeof ficha !== "object") return false;
  return Object.values(ficha).some(v => {
    if (v === null || v === undefined || v === "") return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  });
}

// Decide qual das duas cópias (mesmo código, arquivos diferentes) vence:
// prioriza ter `nome` (registro de produto de verdade — ver guarda em
// _indexarProduto) e, entre duas com nome, prioriza a que tem ficha com
// conteúdo. Em qualquer empate mantém a primeira encontrada (estável,
// determinístico) — só troca quando a nova é estritamente melhor.
function _melhorRegistroDuplicado(atual, novo) {
  if (!atual) return novo;
  if (!atual.nome && novo.nome) return novo;
  if (atual.nome && !novo.nome) return atual;
  if (!_fichaTemConteudo(atual.ficha) && _fichaTemConteudo(novo.ficha)) return novo;
  return atual;
}

function _carregarIndices() {
  let arquivos;
  try {
    arquivos = fs.readdirSync(DIR_CATALOGO)
      .filter(f => f.endsWith(".json") && !ARQUIVOS_NAO_PRODUTO.has(f));
  } catch (e) {
    console.error("[catalogo-x2.service] pasta catalogo-x2 não encontrada:", e.message);
    return;
  }

  // Pré-varre TODOS os arquivos antes de indexar de verdade, resolvendo
  // duplicatas de código entre arquivos (ver comentário acima) — só depois
  // chama _indexarProduto uma vez por código, já com o melhor registro
  // escolhido, em vez de indexar tudo em ordem de arquivo e deixar o último
  // sobrescrever cegamente.
  const melhorPorCodigo = new Map();
  for (const arquivo of arquivos) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(DIR_CATALOGO, arquivo), "utf-8"));
    } catch (e) {
      console.error(`[catalogo-x2.service] falha ao ler ${arquivo}:`, e.message);
      continue;
    }
    for (const p of data) {
      if (!p || !p.codigo) continue;
      melhorPorCodigo.set(p.codigo, _melhorRegistroDuplicado(melhorPorCodigo.get(p.codigo), p));
    }
  }

  // Aplica correções manuais de categoria (ver comentário de
  // CORRECOES_CATEGORIA_PATH acima) ANTES de indexar — assim a Linha
  // corrigida propaga sozinha pra todo mundo que lê `p.linha`/`item.linha`
  // depois (busca por veículo/nome/código, Catálogo Completo, índice do
  // PDF, dropdown de Linhas), sem precisar duplicar a lógica em cada lugar.
  const correcoes = _garantirCorrecoesCategoria();
  for (const p of melhorPorCodigo.values()) {
    const correcao = correcoes.get(String(p.codigo));
    if (correcao) p.linha = correcao.linha;
    _indexarProduto(p);
  }

  console.log(
    `[catalogo-x2.service] índice pronto: ${totalProdutosIndexados} produtos, ` +
    `${equivalenteIndex.size} códigos equivalentes, ${produtosComAplicacao.length} com aplicação/veículo ` +
    `(${todosProdutos.length - produtosComAplicacao.length} sem aplicação, navegáveis só por Seção/Linha), ` +
    `${fabricanteCount.size} fabricantes distintos identificados.`
  );
}

// Só entram no dropdown de filtro os fabricantes com um mínimo de produtos
// (>=5) — corta ruído residual do parsing (ex: valores que passaram pelo
// filtro de ruído mas são só ocorrências raras/erros de digitação isolados)
// sem esconder marcas reais pequenas da loja.
const FABRICANTE_MIN_OCORRENCIAS = 5;
let fabricantesDisponiveis = [];

// "MECÂNICA" é uma das 26 seções oficiais do X2 (ver SECOES em
// x2-fotos-scraper.js — junto de ALTERNADOR, BUZINAS, COMPONENTES
// ELÉTRICOS etc.). Pedido do usuário (2026-09-03): um fabricante como
// PERFECT pode ter peças cadastradas em "MECÂNICA" E em outras seções
// (as "elétricas", no vocabulário do usuário) ao mesmo tempo — usada por
// listarFabricantesCatalogoCompleto/buscarProdutosPainel (tipoCompleto)
// pra separar os dois em catálogos diferentes.
const SECAO_MECANICA_NORM = _normalizar("MECÂNICA");

// Palavras que vêm dos nomes das 26 seções (ex: "motor", "partida",
// "alternador", "injecao", "eletronica") — nunca servem de sinal de
// veículo, porque o texto de aplicação quase sempre cita o termo mecânico
// da própria peça (ex: "...COM MOTOR MWM..." aparece em qualquer produto
// mecânico, de caminhão a carro de passeio). Achado ao vivo em 2026-07-21:
// "motor de partida pro corolla 2015" bateu num motor de ônibus só porque
// "motor" aparecia no texto de aplicação — sem nenhuma relação com Corolla.
let PALAVRAS_CATEGORIA = new Set();

// PEDIDO DO USUÁRIO (2026-08-12): "seria algum ganho [recarregar catálogo/
// fotos sem reiniciar o bot, igual estoque]?" — até aqui _carregarIndices()
// só rodava uma vez no require() do módulo; uma rotina "Cadastrar produtos
// novos"/"Atualizar Fotos" rodando sozinha (agendada) deixava o resultado
// preso em disco sem efeito nenhum na busca real até alguém reiniciar o
// bot manualmente — a automação ficava pela metade. `recarregarIndices()`
// limpa e repopula os MESMOS objetos Map/Array module-level (não recria
// referências novas — funções que já capturaram esses bindings continuam
// funcionando sem mudança nenhuma) e recalcula os dois derivados
// (fabricantesDisponiveis/PALAVRAS_CATEGORIA), que antes só eram montados
// uma vez logo após o load inicial. Mesmo padrão de recarregarEstoqueHandler
// em catalogo.controller.js.
function recarregarIndices() {
  equivalenteIndex.clear();
  referenciaIndex.clear();
  produtosPorCodigoIndex.clear();
  produtosComAplicacao.length = 0;
  todosProdutos.length = 0;
  secoesConhecidas.clear();
  fabricanteCount.clear();
  totalProdutosIndexados = 0;

  _carregarIndices();

  fabricantesDisponiveis = [...fabricanteCount.entries()]
    .filter(([, contagem]) => contagem >= FABRICANTE_MIN_OCORRENCIAS)
    .map(([nome]) => nome)
    .sort((a, b) => a.localeCompare(b, "pt-BR"));

  PALAVRAS_CATEGORIA = new Set(
    [...secoesConhecidas.values()].flatMap(secao => _normalizar(secao).split(" "))
      .filter(w => w.length >= 3)
      .map(w => w.toLowerCase())
  );
}

recarregarIndices();

// ─── Correção manual de categoria (Linha) — pedido do usuário 2026-09-05 ──
// Ver comentário de CORRECOES_CATEGORIA_PATH acima pro porquê do overlay em
// vez de editar o JSON de produto direto.

/**
 * Lista, pra cada Seção conhecida, as Linhas já existentes nela — usado
 * pelo dropdown "editar categoria" do painel (escolher uma Linha existente
 * evita criar "MANÔMETRO DO ÓLEO" e "MANOMETRO DO OLEO" como duas Linhas
 * parecidas por erro de digitação; digitar uma Linha nova continua livre).
 * Computado sob demanda (não fica em cache) — só é chamado quando o
 * atendente abre o formulário de edição, não em toda busca do painel.
 *
 * NOME DE PROPÓSITO DIFERENTE de `listarLinhasPorSecao` (catalogo.service.js
 * — dropdown dependente Seção→Linha da busca do painel, recebe 1 `secao` e
 * devolve só as linhas dela, vindo das ~397 linhas genéricas cadastradas à
 * mão, não deste catálogo X2). Nomes parecidos de propósito, serviços
 * diferentes — não confundir/importar um pelo outro.
 */
function listarLinhasParaEdicaoCategoria() {
  const porSecao = new Map();
  for (const p of todosProdutos) {
    if (!p.secao || !p.linha) continue;
    if (!porSecao.has(p.secao)) porSecao.set(p.secao, new Set());
    porSecao.get(p.secao).add(p.linha);
  }
  return [...porSecao.entries()]
    .map(([secao, linhas]) => ({ secao, linhas: [...linhas].sort((a, b) => a.localeCompare(b, "pt-BR")) }))
    .sort((a, b) => a.secao.localeCompare(b.secao, "pt-BR"));
}

/**
 * Corrige a Linha de um produto (código interno da loja) — persiste em
 * categoria-correcoes.json e recarrega os índices na hora pra já valer na
 * busca/Catálogo Completo seguintes, sem precisar de reinício. Lança erro
 * "de negócio" (código não encontrado / linha vazia) — o controller trata
 * como 400, não 500. `novaLinha` vazia/null REMOVE a correção (volta a
 * mostrar o valor original do X2).
 */
function definirLinhaProduto(codigo, novaLinha) {
  const norm = _normalizarCodigo(codigo);
  const produto = produtosPorCodigoIndex.get(norm);
  if (!produto) {
    throw new Error(`Código "${codigo}" não encontrado no catálogo.`);
  }

  const linhaLimpa = String(novaLinha || "").trim();
  const correcoes = _garantirCorrecoesCategoria();

  if (!linhaLimpa) {
    correcoes.delete(produto.codigo);
  } else {
    correcoes.set(produto.codigo, { linha: linhaLimpa });
  }
  _salvarCorrecoesCategoria();
  recarregarIndices();

  const atualizado = produtosPorCodigoIndex.get(norm);
  return atualizado || null;
}

// ─── Fabricante da peça (Task #250-252, pedido do usuário em 2026-07-23) ──
function listarFabricantes() {
  return fabricantesDisponiveis;
}

// Pedido do usuário (2026-09-03): "temos a divisão de peças cadastradas
// como mecânica para esses catálogos [...] preciso que faça a separação
// das que são elétricas e mecânicas [...] quando eu for selecionar o
// tipo de catálogo que eu queira preciso que tenha essa separação algo
// como Perfect - Mecânica" — usada só pelo seletor da aba "Catálogo
// Completo" (não pelo filtro comum de fabricante do painel, que continua
// em listarFabricantes() sem separação). Cada fabricante vira 1 ou 2
// "opções": se ele tem produto NA seção MECÂNICA e produto FORA dela ao
// mesmo tempo, vira duas opções (uma pra cada tipo); se só tem um dos
// dois, vira uma opção só — rotulada "- Mecânica" quando é esse o único
// tipo (pra bater com o pedido "Perfect - Mecânica"), mas SEM rótulo
// quando o único tipo é "fora de MECÂNICA" (a esmagadora maioria dos
// fabricantes, que nunca teve nada em MECÂNICA — não faz sentido
// rotular todo mundo de "- Elétrica" só por causa de alguns poucos que
// têm as duas). `value` é o que o frontend devolve pra
// /api/catalogo/buscar e /api/catalogo/exportar-pdf sem tradução
// nenhuma — ver decodificarFabricanteCompleto, que entende o sufixo
// "::mecanica"/"::eletrica".
// Pedido do usuário (2026-09-05): "linha diversos não existe no nosso
// sistema [como Linha] mas a subcategoria 'Diversos' nas aplicações
// existe [...] pegue esses produtos com linhas diversos e coloque como se
// fosse outro Fabricante em outro catalogo mesmos com produtos de outros
// fabricantes [...] agrupe por marca de veículo [...] em catalogo
// completo, deixe no selection a opção diversos" — X2 usa "DIVERSOS" como
// Linha catch-all (peça sem categoria específica, ver produto real
// código 126633 "PORCA CONEXAO... MBB/VALMET", linha="DIVERSOS", em
// vários fabricantes/Seções diferentes). Em vez de cada fabricante exibir
// sua fatia de "Diversos" misturada com as Linhas de verdade dele (onde
// vira ruído — não é uma Linha informativa), essa pseudo-opção agrega
// TODOS os produtos linha="DIVERSOS" da base inteira (cruzando
// fabricante) num catálogo à parte, reaproveitando a mesma tela/seletor
// de sempre — ver buscarProdutosPainel (filtro por p.linha em vez de
// p.fabricante quando fabricanteNorm==="DIVERSOS") e
// gerarPdfCatalogoCompleto(agruparPorMarca=true) em catalogo-pdf.service.js
// (agrupa por marca de veículo em vez de por Linha, já que aqui todo
// mundo compartilha a mesma Linha catch-all — agrupar por ela seria
// inútil).
const PSEUDO_FABRICANTE_DIVERSOS = "DIVERSOS";

function listarFabricantesCatalogoCompleto() {
  const porFabricante = new Map(); // fabricante -> { temMecanica, temOutras }
  let temProdutoDiversos = false;
  todosProdutos.forEach((p) => {
    if (_normalizar(p.linha) === _normalizar(PSEUDO_FABRICANTE_DIVERSOS)) temProdutoDiversos = true;
    if (!p.fabricante) return;
    if (!porFabricante.has(p.fabricante)) porFabricante.set(p.fabricante, { temMecanica: false, temOutras: false });
    const info = porFabricante.get(p.fabricante);
    if (p.secao && _normalizar(p.secao) === SECAO_MECANICA_NORM) info.temMecanica = true;
    else info.temOutras = true;
  });

  const opcoes = [];
  fabricantesDisponiveis.forEach((fabricante) => {
    const info = porFabricante.get(fabricante) || { temMecanica: false, temOutras: false };
    if (info.temMecanica && info.temOutras) {
      opcoes.push({ value: `${fabricante}::mecanica`, label: `${fabricante} - Mecânica` });
      opcoes.push({ value: `${fabricante}::eletrica`, label: `${fabricante} - Elétrica` });
    } else if (info.temMecanica) {
      opcoes.push({ value: `${fabricante}::mecanica`, label: `${fabricante} - Mecânica` });
    } else {
      opcoes.push({ value: fabricante, label: fabricante });
    }
  });
  // Sempre por último — pseudo-opção, não é um fabricante de verdade, não
  // faz sentido intercalada em ordem alfabética com os fabricantes reais.
  if (temProdutoDiversos) {
    opcoes.push({ value: PSEUDO_FABRICANTE_DIVERSOS, label: "Diversos (todos os fabricantes)" });
  }
  return opcoes;
}

// Decodifica o `value` vindo do seletor da aba "Catálogo Completo" (ver
// listarFabricantesCatalogoCompleto acima) — separa o nome do fabricante
// de verdade do sufixo "::mecanica"/"::eletrica", se tiver algum. Usada
// tanto por /api/catalogo/buscar (contagem antes de gerar) quanto por
// /api/catalogo/exportar-pdf (geração de verdade), pra sempre concordarem
// no mesmo total. "::" nunca ocorre num nome de fabricante de verdade
// (vem sempre do dropdown, nunca de texto livre digitado), então essa
// checagem não arrisca cortar um fabricante legítimo que tenha esses
// caracteres por acaso.
function decodificarFabricanteCompleto(valorBruto) {
  const valor = String(valorBruto || "").trim();
  const match = valor.match(/^(.*)::(mecanica|eletrica)$/);
  if (!match) return { fabricante: valor, tipoCompleto: null };
  return { fabricante: match[1], tipoCompleto: match[2] };
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
// ou null (sem dado de estoque pra esse código). Cobertura real (export
// de 2026-09-05, ver src/data/estoque-latest.csv): 17.569 produtos, 100%
// com preço — bem perto do catálogo inteiro. O "cobre só ~5.200 de
// 17.400" documentado aqui antes vinha de um export truncado por um bug
// no scraper (fixado 2026-08-10, ver scripts/x2-estoque-export.js) que
// ninguém tinha revalidado com uma rodada nova até agora — não é mais
// verdade, mas como é um export do dia (roda de novo periodicamente),
// null continua sendo um caso real e esperado, não bug.
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

  // ORDEM IMPORTA: Set preserva ordem de inserção, e resultado[0] é usado
  // como "melhor match" em vários pontos (ex: _resolverProdutosPorCodigos
  // no catalogo.controller.js). BUG REAL achado 2026-09-01 testando import
  // de preços com arquivo real (Wega Estoque.xlsx): equivalente (OEM de
  // OUTRO fabricante que só CITA este código como referência cruzada) era
  // inserido ANTES do match exato da própria referência/código interno —
  // então buscar "JFA0K14" (referência própria do produto Wega 123517)
  // devolvia primeiro o produto 129168 (Filtros Brasil, EAFB114), que só
  // lista JFA0K14 como equivalente OEM. Preço do arquivo caía certo (o
  // valor buscado era o mesmo), mas o PRODUTO exibido/cadastrado ficava
  // errado. Fix: match exato (código interno da loja ou referência própria
  // do produto) sempre vem primeiro; equivalente/OEM só como fallback.
  const codigosInternos = new Set();
  if (produtosPorCodigoIndex.has(codigo)) codigosInternos.add(codigo);
  if (referenciaIndex.has(codigo)) codigosInternos.add(_normalizarCodigo(referenciaIndex.get(codigo).codigo));
  for (const item of (equivalenteIndex.get(codigo) || [])) {
    codigosInternos.add(_normalizarCodigo(item.codigo));
  }

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
      dadosTecnicos: item.dadosTecnicos || null,
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
// PEDIDO DO USUÁRIO (2026-08-14): "preciso que meu bot reconheça todos os
// produtos cadastrados na loja pelo código do fabricante, código da loja e
// número original". Antes desta mudança, esta função (a única chamada pelo
// fluxo de atendimento ao CLIENTE via ai.service.js) só consultava
// equivalenteIndex (número original/OEM de terceiros) e referenciaIndex
// (código de referência do próprio fabricante da peça) — nunca
// produtosPorCodigoIndex (código interno da loja, ex: "120991"). Resultado:
// um cliente perguntando "tem o 120991?" não recebia confirmação nenhuma de
// catálogo, mesmo o produto existindo. buscarPorCodigo() (abaixo) já
// consultava os 3 índices, mas só é usada pelo painel administrativo (exige
// 1 código já isolado, sem a extração de tokens de texto livre que o bot
// precisa). Adicionado aqui o mesmo terceiro índice, mantendo a extração de
// texto livre — agora os 3 tipos de código (loja/fabricante/original) são
// reconhecidos no chat do cliente, iguais ao que o painel já reconhecia.
function buscarPorCodigoOriginal(texto, { limite = 5 } = {}) {
  const candidatos = _extrairCodigosDoTexto(texto);
  if (!candidatos.length) return [];

  const encontrados = [];
  const vistos = new Set();
  for (const codigo of candidatos) {
    const porEquivalente   = equivalenteIndex.get(codigo) || [];
    const porReferencia    = referenciaIndex.has(codigo) ? [referenciaIndex.get(codigo)] : [];
    const porCodigoInterno = produtosPorCodigoIndex.has(codigo) ? [produtosPorCodigoIndex.get(codigo)] : [];
    for (const item of [...porEquivalente, ...porReferencia, ...porCodigoInterno]) {
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
// BUG REAL relatado pelo usuário (2026-08-14, print de conversa real):
// "Vocês trabalham com linha pesada, tipo caminhão Volvo?" — pergunta
// GENÉRICA de categoria, sem citar peça nenhuma — confirmou "PALHETA 26
// VETOR P/CAMINHAO VOLVO..." (um limpador de para-brisa) só porque
// "CAMINHAO" e "VOLVO" batiam como substring dentro do NOME do produto
// (que embute a lista de aplicação). Mesma causa raiz do bug de
// "peça"/veículo já corrigido em buscarPorNomeProduto (ver
// PALAVRAS_GENERICAS_PECA mais abaixo) — só que aqui o token problemático
// era "CAMINHAO" (tipo de veículo genérico), que ficou de fora da lista
// original por descuido: "carro"/"veiculo" já eram tratados como filler
// óbvio demais pra identificar um veículo específico, mas "caminhao"/
// "moto"/"onibus" (mesma categoria semântica) não estavam.
const STOPWORDS_VEICULO = new Set([
  "tem", "tém", "têm", "pra", "pro", "para", "com", "uma", "um", "dos", "das",
  "que", "voce", "voces", "vcs", "tenho", "precis", "preciso", "gostaria",
  "meu", "minha", "carro", "veiculo", "modelo", "ano", "tipo", "aquele", "aquela",
  "caminhao", "caminhoes", "moto", "motos", "onibus",
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

// ─── Busca por nome real do produto (pedido do usuário, 2026-08-14: "preciso
// que alimente o bot com todo o banco de dados da loja") ───────────────────
// Antes desta função, o bot só confirmava a existência de uma peça de duas
// formas: citando o CÓDIGO (buscarPorCodigoOriginal) ou citando o nome de uma
// das 397 linhas/categorias GENÉRICAS pré-cadastradas em
// catalogo.service.buscarNoCatalogo (ex: "Alternador Completo"). Se o
// cliente descrevesse a peça de um jeito que não batesse EXATAMENTE com
// nenhuma dessas 397 linhas, o bot não confirmava nada — mesmo que o produto
// existisse, com nome próprio, entre os ~17.520 itens reais do catálogo X2.
// Esta função cruza os tokens da mensagem direto contra o NOME REAL de cada
// produto (ex: "ALTERNADOR 12V 90A *SUBST* - DELCO - DR101N10013"),
// cobrindo esse buraco.
// Mesma prudência de buscarPorVeiculo ("1 palavra solta bate por acaso
// demais pra ser confiável" — ver comentário acima): exige >=2 tokens
// distintos batendo no nome quando a mensagem tem 2+ tokens úteis; só aceita
// 1 único token quando a mensagem inteira só tem 1 (e mesmo assim exige
// >=6 caracteres, pra reduzir falso positivo de palavra curta/genérica tipo
// "farol" batendo em produto errado da mesma categoria).
//
// BUG REAL achado ao rodar os testes depois de ligar esta função no override
// determinístico do ai.service.js (2026-08-14): mensagens SEM nome de peça
// nenhum — só "peça" genérica + marca/modelo do carro, ex. "preciso de uma
// peça pro meu fiat palio 2025" — bateram em produtos cujo campo NOME embute
// a lista de aplicação (ex: "PALHETA ... FIAT:UNO, PALIO"). Os 2 tokens que
// batiam (FIAT, PALIO) eram só o veículo que o cliente já tinha citado, não
// nome de peça nenhuma — resultado: bot confirmava categoria errada (palheta
// de limpador) pra um cliente que só falou "uma peça". Fix: (1) "peça" e
// sinônimos genéricos não contam como token; (2) quando o chamador já
// extraiu o veículo do cliente (parâmetro `veiculoTexto`), as palavras desse
// veículo também são descontadas dos tokens válidos — só sobra o match se
// houver alguma palavra que REALMENTE descreva a peça, não só o carro.
const PALAVRAS_GENERICAS_PECA = new Set([
  "peca", "pecas", "peco", "produto", "produtos", "coisa", "algo",
  "componente", "acessorio", "item", "negocio", "troço", "troco",
  // BUG REAL relatado pelo usuário (2026-08-14, print de conversa real):
  // "Vocês trabalham com linha pesada, tipo caminhão Volvo?" — pergunta
  // sobre o SEGMENTO/categoria que a loja atende (mesmo vocabulário do
  // prompt da IA: "linha leve/pesada/agrícola", ver ai.service.js), não o
  // nome de peça nenhuma — mas confirmou uma PALHETA (limpador de
  // para-brisa) qualquer que por acaso tinha "VOLVO" na aplicação embutida
  // no nome, porque "LINHA" também contava como token válido de match. Como
  // "linha"/"pesada"/"leve"/"agrícola" descrevem o SEGMENTO que a loja
  // vende (não uma peça específica), nunca devem contar como sinal de
  // produto — mesmo raciocínio de "peça"/"produto" acima.
  "linha", "linhas", "pesada", "pesado", "pesadas", "pesados",
  "leve", "leves", "agricola", "agricolas",
]);

function buscarPorNomeProduto(mensagem, { limite = 3, veiculoTexto = null } = {}) {
  const msgNormalizada = _normalizar(mensagem);
  const excluirVeiculo = veiculoTexto
    ? new Set(_normalizar(veiculoTexto).split(" ").map(w => w.toLowerCase()))
    : null;
  const tokens = msgNormalizada.split(" ")
    .filter(t => {
      const tl = t.toLowerCase();
      if (t.length < 3) return false;
      if (STOPWORDS_VEICULO.has(tl) || PALAVRAS_GENERICAS_PECA.has(tl)) return false;
      if (excluirVeiculo && excluirVeiculo.has(tl)) return false;
      return true;
    });
  if (!tokens.length) return [];

  const minNecessario = tokens.length >= 2 ? 2 : (tokens[0].length >= 6 ? 1 : 2);
  if (minNecessario > tokens.length) return [];

  const candidatos = [];
  for (const p of todosProdutos) {
    if (!p.nomePalavras) continue;
    let matches = 0;
    for (const t of tokens) {
      if (p.nomePalavras.has(t)) matches++;
    }
    if (matches >= minNecessario) candidatos.push({ p, matches });
  }
  if (!candidatos.length) return [];

  // Mais tokens batendo primeiro — match mais específico/confiável na frente.
  candidatos.sort((a, b) => b.matches - a.matches);
  return candidatos.slice(0, limite).map(c => c.p);
}

// ─── Busca por NOME da peça pro painel "Catálogo de Produtos" (pedido do
// usuário, 2026-08-14): "gostaria que no meu painel de catálogo também
// tivesse opção de pesquisar por peça nome" — 3ª forma de busca, ao lado de
// "Busca por Veículo" e "Busca por Código". Diferente de buscarPorNomeProduto
// (usado pelo BOT contra mensagem livre do cliente — filtra palavra
// genérica/veículo pra não confirmar peça errada quando o cliente não citou
// nome nenhum): aqui o atendente está deliberadamente pesquisando por nome, é
// texto controlado, digitado com intenção — não precisa da mesma cautela.
// Busca por SUBSTRING (palavra parcial já acha, ex: "alternad" acha
// "ALTERNADOR") e exige TODAS as palavras digitadas presentes no nome, sem
// stopword nem mínimo de tokens.
function buscarPorNomePainel(nomeBusca, { limite = 200 } = {}) {
  const termo = _normalizar(nomeBusca);
  const palavras = termo.split(" ").filter(w => w.length >= 2);
  if (!palavras.length) return { total: 0, produtos: [] };

  const encontrados = todosProdutos.filter(p =>
    p.nomeNormalizado && palavras.every(w => p.nomeNormalizado.includes(w))
  );

  // Nome mais curto primeiro: entre duas peças que batem nas mesmas
  // palavras, a de nome mais enxuto tende a ser o resultado mais "exato"
  // (nome longo geralmente é porque embute lista de aplicação/variação,
  // ex: "PALHETA 26 VETOR P/CAMINHAO VOLVO FH12,NH12 94>,IVECO:..."), e
  // depois ordem alfabética pra desempate estável.
  encontrados.sort((a, b) => a.nome.length - b.nome.length || a.nome.localeCompare(b.nome, "pt-BR"));

  const total = encontrados.length;
  const produtos = encontrados.slice(0, limite).map(p => ({
    codigo: p.codigo,
    nome: p.nome,
    secao: p.secao,
    linha: p.linha,
    referencia: p.referencia,
    fabricante: p.fabricante,
    aplicacao: p.aplicacao,
    dadosTecnicos: p.dadosTecnicos || null,
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
function buscarProdutosPainel({ marca = "", modelo = "", ano = null, anoInicio = null, anoFim = null, motor = "", categoria = "", fabricante = "", tipoCompleto = null, limite = 200 } = {}) {
  const marcaTokens  = _tokens(marca);
  const modeloTokens = _tokens(modelo);
  // PEDIDO DO USUÁRIO (2026-09-04, referência KKI Vendas): campo único "Ano"
  // do painel virou "Ano Inicial"/"Ano Final". `ano` continua aceito por
  // compatibilidade (chamadores antigos/rotas que não migraram) — quando só
  // ele vem preenchido, funciona como sempre funcionou (ano único).
  const anoIni = anoInicio ? Number(anoInicio) : (ano ? Number(ano) : null);
  const anoF   = anoFim ? Number(anoFim) : null;
  // PEDIDO DO USUÁRIO (2026-09-04, referência KKI Vendas): campo novo
  // "Motor" — filtro ADICIONAL (só entra em jogo quando preenchido), por
  // substring (não palavra inteira) contra o texto de aplicação já
  // normalizado, porque especificação de motor no texto real varia demais
  // pra exigir token exato ("1.6 16V DOHC L4", "MPI - gasolina", "2.0 8V")
  // — mesma lógica de tolerância já usada em buscarPorNomePainel.
  const motorNorm = motor && String(motor).trim() ? _normalizar(motor) : null;
  const categoriaNorm = categoria && String(categoria).trim() ? _normalizar(categoria) : null;
  // Fabricante é filtro por igualdade exata (não substring) — vem sempre do
  // dropdown já normalizado por listarFabricantes(), não de texto livre.
  const fabricanteNorm = fabricante && String(fabricante).trim() ? String(fabricante).trim().toUpperCase() : null;
  // Pedido do usuário (2026-09-03, aba "Catálogo Completo" — ver
  // listarFabricantesCatalogoCompleto/decodificarFabricanteCompleto): filtro
  // adicional por tipo dentro do fabricante já escolhido — "mecanica" só
  // produto na seção MECÂNICA, "eletrica" só produto FORA dela. `null`
  // (padrão) não filtra nada, mesmo comportamento de sempre pro resto do
  // painel (busca normal, filtro comum de fabricante).
  const filtroTipoCompleto = (p) => {
    if (tipoCompleto === "mecanica") return !!p.secao && _normalizar(p.secao) === SECAO_MECANICA_NORM;
    if (tipoCompleto === "eletrica") return !p.secao || _normalizar(p.secao) !== SECAO_MECANICA_NORM;
    return true;
  };

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
      if (fabricanteNorm === PSEUDO_FABRICANTE_DIVERSOS) {
        // Pseudo-fabricante "Diversos" (ver listarFabricantesCatalogoCompleto):
        // ignora p.fabricante de propósito — agrega por p.linha="DIVERSOS"
        // cruzando TODOS os fabricantes, não só um.
        if (_normalizar(p.linha) !== _normalizar(PSEUDO_FABRICANTE_DIVERSOS)) return false;
      } else if (fabricanteNorm && (!p.fabricante || p.fabricante.toUpperCase() !== fabricanteNorm)) {
        return false;
      }
      if (!filtroTipoCompleto(p)) return false;
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
      aplicacaoOrganizada: _aplicacaoOrganizadaCache(p.aplicacao),
      dadosTecnicos: p.dadosTecnicos || null,
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
    if (!filtroTipoCompleto(p)) continue;
    // PEDIDO DO USUÁRIO (2026-09-04, referência KKI Vendas): filtro por
    // Motor é EXCLUDENTE (diferente de marca/ano, que só ranqueiam) — só
    // entra em jogo quando preenchido, e aí sim corta quem não bate, porque
    // é um campo NOVO e opcional: quem não usar não muda em nada o
    // comportamento de busca já validado antes.
    if (motorNorm && !(p.aplicacaoNormalizada || "").includes(motorNorm)) continue;

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
    const anoCompativel = _anoCompativel(p.faixasAno, anoIni, anoF);

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
    aplicacaoOrganizada: _aplicacaoOrganizadaCache(p.aplicacao),
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
  buscarPorNomeProduto,
  buscarPorNomePainel,
  buscarProdutosPainel,
  buscarPorCodigo,
  listarFabricantes,
  listarFabricantesCatalogoCompleto,
  listarMarcasVeiculoConhecidas,
  decodificarFabricanteCompleto,
  recarregarIndices,
  listarLinhasParaEdicaoCategoria,
  definirLinhaProduto,
  PSEUDO_FABRICANTE_DIVERSOS,
};
