#!/usr/bin/env node
/**
 * scripts/x2-lancamentos-scraper.js
 *
 * PEDIDO DO USUÁRIO (2026-08-11): a aba "Lançamentos" do Painel Fotos X2
 * hoje (`x2-painel/lancamentos.js`) deduz "produto novo" comparando CSVs de
 * estoque dia a dia — funciona, mas só enxerga a partir de 06/08/2026 (data
 * em que começamos a guardar snapshot) e é uma INFERÊNCIA nossa, não um dado
 * que o X2 realmente afirma. O usuário mandou o PDF
 * "Lista de Lançamentos2026.pdf" (procedimento manual que a equipe já usa
 * toda semana pra gerar o catálogo impresso de lançamentos) mostrando que o
 * X2 tem uma tela que responde essa pergunta de verdade: ☰ > Compras >
 * Catálogo de Produtos, com o filtro "Apenas produtos com primeira entrada"
 * — literalmente "isso aqui é lançamento?" respondido pelo próprio sistema,
 * sem limite de data nenhum.
 *
 * ─── Navegação e seletores (CONFIRMADOS AO VIVO 2026-08-11, via Claude in
 * Chrome — sessão já logada do usuário, leitura/preenchimento de formulário
 * e clique real em "Pesquisar Produto", não é heurística) ─────────────────
 * ☰ > tile "Compras" > link "Catálogo de Produtos" (mesmo tile que já usamos
 * pra Curva ABC — `x2-curva-abc-parados-scraper.js`). Formulário mora no
 * `window.frames[1]`, action real: `compra/catalogo_produto/catalogo_pesquisa.jsp`.
 *
 * Campos reais do formulário "Critérios de Pesquisa":
 *   - `id_empresa` (select) — "" = Todas as 3 unidades numa query só
 *     (RILDON=1, DIST=2, EC=3). Confirmado: com "Todas" selecionado, cada
 *     produto aparece 1x POR UNIDADE em que teve entrada — é preciso
 *     deduplicar por código (ver `_normalizarLancamentos` abaixo). Resolve
 *     sozinho a regra "sempre as 3 unidades" numa única consulta, sem
 *     precisar rodar 3x feito nos outros scripts.
 *   - `dt_inicio` / `dt_fim` (texto dd/mm/aaaa) — "Data de Cadastro". O PDF
 *     manda deixar fixo 02/11/2020 até hoje — na prática não filtra nada
 *     (intervalo gigante), é só o padrão que a equipe sempre usou.
 *   - `dt_inicio_recebimento` / `dt_fim_recebimento` (texto dd/mm/aaaa) —
 *     "Periodo de Recebimento". Esse é o filtro real da semana (segunda a
 *     sábado).
 *   - `radio_primeira_entrada` (radio, valores S/N, default N) — precisa
 *     virar "S". É o campo-chave: o X2 dizendo "essa foi a 1ª entrada desse
 *     produto", não uma dedução nossa.
 *   - Demais campos (`radio_medidas`, `radio_imagem`, `radio_descricao`,
 *     `radio_estoque`, `in_controle_promocao`, `in_exibir_produto_ecommerce`)
 *     ficam no default "Indiferente" — não precisam ser tocados.
 *   - Botão: `<input value="Pesquisar Produto" onclick="pesquisar()">`.
 *
 * ─── Resultado (confirmado ao vivo com um filtro de teste real) ───────────
 * Tabela HTML dentro do mesmo frame, SEM `id` — localizada pelo mesmo
 * critério de `_lerTabelaLancamentos` abaixo (mais de 3 linhas, cabeçalho
 * contém "Produto"). Layout: linha de cabeçalho, depois GRUPOS DE 3 linhas
 * por produto (1 linha de dado com 5 `<td>`, 2 linhas espaçadoras vazias com
 * 1 `<td>` cada) — filtro pra linha de dado é `cells.length === 5`.
 *   - cell[0]: índice
 *   - cell[1]: checkbox de seleção
 *   - cell[2]: "CÓDIGO - descrição comercial - fabricante - cód.fabricante
 *     Código de barras: NNNN SEÇÃO > SUBSEÇÃO" (tudo concatenado em texto
 *     corrido, sem separador confiável entre descrição/fabricante — ver
 *     regex em `_normalizarLancamentos`)
 *   - cell[3]: "1. Referência: X 2. Descrição: Y 3. Dados Técnicos: ... 4.
 *     Aplicação: ... 5. Sistema: ... 6. N° Original/Equivalentes: ..." —
 *     campos numerados e rotulados, mais confiável de extrair que cell[2].
 *   - cell[4]: Peso/Altura/Largura/Comprimento (inputs de volumetria,
 *     não usados aqui).
 *
 * ─── O que NÃO foi confirmado ao vivo ──────────────────────────────────────
 * Só testei com ~17 produtos únicos num filtro de ~2 semanas — não vi um
 * resultado GRANDE (ex: se o filtro pegasse centenas de produtos, não sei
 * se a tela pagina ou lista tudo numa tabela só). Se `_aguardarTabelaEstavel`
 * nunca estabilizar num volume alto, é o primeiro lugar pra olhar.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-lancamentos-scraper.js
 *
 * Por padrão captura a ÚLTIMA SEMANA COMPLETA (segunda a sábado, nunca a
 * semana em andamento — ver calcularSemanaRecebimento). Cada execução SALVA em
 * `~/.x2-rildon-scraper/lancamentos-x2/captura-<segunda>_a_<sabado>.json` e
 * ATUALIZA `ultima-captura.json` — não sobrescreve semanas antigas, então dá
 * pra manter histórico de verdade (diferente da limitação de
 * `x2-painel/lancamentos.js`, que só enxerga a partir de quando começamos a
 * guardar CSV de estoque).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ExcelJS = require('exceljs');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  WORK_DIR: RAIZ_WORK_DIR,
  LOGIN_URL,
  abrirNavegador,
  tentarLoginAutomaticoSeNecessario,
  clicarTextoExato,
  avaliarEmQualquerFrame,
  comRetry,
  salvarDiagnostico,
} = require('./x2-nav-helpers');

const { SECOES, normalizar } = require('./x2-fotos-scraper');

const LANCAMENTOS_DIR = path.join(RAIZ_WORK_DIR, 'lancamentos-x2');
const ULTIMA_CAPTURA_PATH = path.join(LANCAMENTOS_DIR, 'ultima-captura.json');

function garantirPastas() {
  fs.mkdirSync(LANCAMENTOS_DIR, { recursive: true });
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

function formatarDataBr(data) {
  const dd = String(data.getDate()).padStart(2, '0');
  const mm = String(data.getMonth() + 1).padStart(2, '0');
  const yyyy = data.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Segunda a sábado da ÚLTIMA SEMANA COMPLETA (nunca a semana corrente,
 * mesmo que ela já esteja quase no fim) — mesma regra do procedimento
 * manual ("Última Segunda-Feira" / "Último Sábado"), ex.: 20 a 25/07.
 *
 * ⚠️ Corrigido 2026-08-11: a versão anterior calculava a semana CORRENTE
 * (segunda desta semana até sábado desta semana), que na maioria dos dias
 * ainda nem tinha acontecido inteira (sábado no futuro) — usuário percebeu
 * que o padrão natural do processo manual é sempre olhar pra trás, pra
 * última semana já fechada, não pra semana em andamento. Regra nova: acha a
 * segunda-feira desta semana e SEMPRE volta mais 7 dias, exceto quando hoje
 * é domingo (aí a semana que acabou de terminar ontem, sábado, já é a
 * última semana completa, sem precisar voltar mais). `dia`: 0=domingo..6=sábado. */
function calcularSemanaRecebimento(hoje = new Date()) {
  const dia = hoje.getDay();
  const diasDesdeSegunda = (dia + 6) % 7;
  const segunda = new Date(hoje);
  segunda.setDate(hoje.getDate() - diasDesdeSegunda);
  if (dia !== 0) segunda.setDate(segunda.getDate() - 7); // só domingo já aponta pra semana completa; qualquer outro dia, a "corrente" ainda não terminou
  const sabado = new Date(segunda);
  sabado.setDate(segunda.getDate() + 5);
  return { segunda, sabado };
}

/** Navega até "Compras > Catálogo de Produtos" — mesmo tile de
 * `abrirCurvaAbc` em x2-curva-abc-parados-scraper.js, só muda o link do
 * submenu. */
async function abrirCatalogoProdutosCompras(page, { modoAutomatico } = {}) {
  if (modoAutomatico) {
    await page.goto(LOGIN_URL).catch(() => {});
    await page.waitForTimeout(1000);
    await tentarLoginAutomaticoSeNecessario(page);
    await page.waitForTimeout(1000);
  }

  await page.locator('a').first().click({ timeout: 10000 }); // ☰
  await page.waitForTimeout(500);

  const clicouCompras = await comRetry(
    () => clicarTextoExato(page, 'Compras'),
    (frame) => !!frame,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicouCompras) {
    await salvarDiagnostico(page, LANCAMENTOS_DIR, 'sem-tile-compras');
    throw new Error('Não encontrei o tile "Compras" no menu ☰. Diagnóstico salvo em debug-sem-tile-compras.png/.json.');
  }
  await page.waitForTimeout(800);

  const clicouCatalogo = await comRetry(
    () => clicarTextoExato(page, 'Catálogo de Produtos'),
    (frame) => !!frame,
    { tentativas: 6, esperaMs: 1000 }
  );
  if (!clicouCatalogo) {
    await salvarDiagnostico(page, LANCAMENTOS_DIR, 'sem-link-catalogo-produtos');
    throw new Error('Cliquei em "Compras" mas não achei o link "Catálogo de Produtos" no submenu. Diagnóstico salvo em debug-sem-link-catalogo-produtos.png/.json.');
  }
  await page.waitForTimeout(1500);
}

/** Preenche os critérios de pesquisa — nomes de campo REAIS confirmados ao
 * vivo (ver cabeçalho do arquivo).
 *
 * ⚠️ BUG REAL corrigido 2026-08-11 (achado no 1º teste supervisionado, com
 * login manual confirmado e ainda assim "faltando: todos os campos"): o
 * formulário mora em `window.frames[1]` (ver cabeçalho), não no frame
 * principal — mas `avaliarEmQualquerFrame` para no PRIMEIRO frame cujo
 * avaliador devolve algo truthy, e o objeto `ok` (com todos os campos
 * `false`) É truthy mesmo quando NENHUM campo foi achado. Resultado: parava
 * no frame principal (sem o formulário) e nunca chegava no frame certo.
 * Print do usuário confirmou a tela certa aberta, só com os campos vazios —
 * bateu exatamente com essa teoria. Fix: usa `id_empresa` (select da
 * Unidade, sempre presente nesse formulário) como âncora — se não existir
 * nesse frame, devolve `null` (falsy) pra `avaliarEmQualquerFrame` seguir
 * pro próximo frame em vez de desistir. */
async function configurarFiltrosLancamentos(page, { segunda, sabado } = {}) {
  const { resultado } = await avaliarEmQualquerFrame(page, ({ dtIniRec, dtFimRec }) => {
    if (!document.querySelector('[name="id_empresa"]')) return null; // frame errado — tenta o próximo

    const setVal = (name, val) => {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return false;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const setRadio = (name, val) => {
      const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
      if (!el) return false;
      el.checked = true;
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const ok = {
      unidade: setVal('id_empresa', ''), // "" = Todas as 3 unidades
      dtInicio: setVal('dt_inicio', '02/11/2020'),
      dtFim: setVal('dt_fim', dtFimRec),
      dtInicioRecebimento: setVal('dt_inicio_recebimento', dtIniRec),
      dtFimRecebimento: setVal('dt_fim_recebimento', dtFimRec),
      primeiraEntrada: setRadio('radio_primeira_entrada', 'S'),
    };
    return ok;
  }, { dtIniRec: formatarDataBr(segunda), dtFimRec: formatarDataBr(sabado) });

  if (!resultado) return null;
  const faltando = Object.entries(resultado).filter(([, ok]) => !ok).map(([campo]) => campo);
  if (faltando.length) return { ok: false, faltando };
  return { ok: true };
}

async function clicarPesquisarProduto(page) {
  const frame = await clicarTextoExato(page, 'Pesquisar Produto');
  return !!frame;
}

/** Acha a tabela de resultado (sem id — localizada pelo mesmo critério
 * heurístico confirmado ao vivo: mais de 3 linhas, cabeçalho com "Produto")
 * e extrai só as linhas de DADO (5 células — as espaçadoras têm 1). */
async function _lerTabelaLancamentos(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const tabelas = Array.from(document.querySelectorAll('table'));
    let tabela = null;
    for (const t of tabelas) {
      if (t.rows.length > 3 && /produto/i.test(t.rows[0]?.textContent || '')) { tabela = t; break; }
    }
    if (!tabela) return null;
    const linhas = [];
    for (let i = 1; i < tabela.rows.length; i++) {
      const r = tabela.rows[i];
      if (r.cells.length !== 5) continue; // pula linhas espaçadoras
      linhas.push({
        produto: norm(r.cells[2].textContent),
        detalhada: norm(r.cells[3].textContent),
      });
    }
    return { linhas };
  });
  return resultado || { linhas: [] };
}

async function _aguardarTabelaLancamentosEstavel(page, { timeoutMs = 30000, intervaloMs = 700, estabilidadeMs = 1800 } = {}) {
  const inicio = Date.now();
  let melhor = { linhas: [] };
  let ultimaContagem = -1;
  let desdeQuandoEstavel = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const atual = await _lerTabelaLancamentos(page);
    if (atual.linhas.length >= melhor.linhas.length) melhor = atual;
    if (atual.linhas.length !== ultimaContagem) {
      ultimaContagem = atual.linhas.length;
      desdeQuandoEstavel = Date.now();
    } else if (ultimaContagem >= 0 && Date.now() - desdeQuandoEstavel >= estabilidadeMs) {
      return melhor;
    }
    await page.waitForTimeout(intervaloMs);
  }
  return melhor;
}

/** Regex sobre texto corrido (ver formato real documentado no cabeçalho do
 * arquivo) — best-effort, nunca lança erro: campo que não bate vira null em
 * vez de derrubar a captura inteira. DEDUPLICA por código (confirmado ao
 * vivo: com "Todas" as unidades, cada produto aparece 1x por unidade). */
function _normalizarLancamentos(linhasCruas) {
  const porCodigo = new Map();
  for (const { produto, detalhada } of linhasCruas) {
    const mProduto = produto.match(/^(\d+)\s*-\s*(.*?)\s*Código de barras:\s*(\d+)\s*(.*)$/i);
    const mDetalhe = detalhada.match(/1\.\s*Referência:\s*(.*?)\s*2\.\s*Descrição:\s*(.*?)\s*3\.\s*Dados Técnicos:/i);
    if (!mProduto) continue; // linha não bateu no formato esperado — ignora em vez de quebrar
    const codigo = mProduto[1];
    if (porCodigo.has(codigo)) continue; // já visto (outra unidade) — mantém a 1ª ocorrência
    porCodigo.set(codigo, {
      codigo,
      descricaoComercial: mProduto[2] || null,
      codigoBarras: mProduto[3] || null,
      secao: mProduto[4] || null,
      referenciaFabricante: mDetalhe ? (mDetalhe[1] || null) : null,
      descricaoCurta: mDetalhe ? (mDetalhe[2] || null) : null,
    });
  }
  return Array.from(porCodigo.values());
}

// PEDIDO DO USUÁRIO (2026-09-08): "quando utilizar a ferramenta Lançamentos
// já faça a captura de foto e do produto no mesmo instante" — até aqui,
// Lançamentos só listava código/descrição pra um Excel de referência, sem
// tocar no catálogo de verdade do bot (src/config/catalogo-x2/). Cadastrar
// ficha (x2-catalogo-sync.js) e baixar foto (x2-fotos-scraper.js) só existem
// por SEÇÃO inteira (não por código avulso) — em vez de construir uma
// captura nova por código (mais trabalho, mais superfície pra bug), a
// decisão foi mapear a(s) Seção(ões) que tiveram lançamento nessa semana e
// disparar as duas rotinas existentes só nelas (ver server.js, dentro de
// rodarAcao, tipo "lancamentos-x2").
//
// `produto.secao` vem como texto livre "SEÇÃO > SUBSEÇÃO" (ver cabeçalho do
// arquivo, cell[2] do resultado) — NUNCA confirmado ao vivo contra um volume
// grande de seções distintas (só ~17 produtos, todos aparentemente da mesma
// seção, no teste de 2026-08-11). Por isso o match é best-effort: tenta
// igualdade exata primeiro (normalizado, sem acento/maiúsculo — mesmo
// critério de x2-fotos-scraper.js), cai pra "começa com"/"contém" se não
// bater, e todo texto que não encontrar seção nenhuma vai pra
// `naoMapeados` em vez de travar a captura inteira ou ser descartado
// silenciosamente — quem chama decide o que fazer (hoje: só loga um aviso).
function mapearSecoesTocadas(produtos) {
  const porLabelNormalizado = new Map(
    Object.entries(SECOES).map(([slug, label]) => [normalizar(label), slug])
  );
  const slugs = new Set();
  const naoMapeados = [];

  for (const p of produtos || []) {
    const textoSecao = String(p.secao || '').replace(/^\s*se[cç][aã]o(\s*\/\s*linha)?\s*:\s*/i, '').split('>')[0].replace(/\s*fornecedores\s*:.*$/i, '').trim();
    if (!textoSecao) { naoMapeados.push({ codigo: p.codigo, secaoTexto: p.secao || null }); continue; }
    const norm = normalizar(textoSecao);

    let slug = porLabelNormalizado.get(norm);
    if (!slug) {
      for (const [labelNorm, s] of porLabelNormalizado) {
        if (norm.startsWith(labelNorm) || labelNorm.startsWith(norm) || norm.includes(labelNorm)) {
          slug = s;
          break;
        }
      }
    }

    if (slug) slugs.add(slug);
    else naoMapeados.push({ codigo: p.codigo, secaoTexto: p.secao || null });
  }

  return { slugs: Array.from(slugs), naoMapeados };
}

/** dd/mm/aaaa -> Date. Retorna null se o texto não bater no formato (em vez
 * de lançar erro) — deixa a chamada decidir se cai no default da semana. */
function _parseDataBr(texto) {
  const m = String(texto || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

async function capturarLancamentos(context, { modoAutomatico, hoje = new Date(), dataInicioRecebimento, dataFimRecebimento } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await abrirCatalogoProdutosCompras(page, { modoAutomatico });

  // PEDIDO DO USUÁRIO (2026-08-11, "testar a ferramenta... do sábado
  // retrasado até essa segunda"): além do default (última semana completa), aceita
  // um período explícito pra reprocessar/testar qualquer intervalo — mesmos
  // campos do X2 (dt_inicio_recebimento/dt_fim_recebimento), só que
  // passados de fora em vez de calculados.
  const inicioCustom = _parseDataBr(dataInicioRecebimento);
  const fimCustom = _parseDataBr(dataFimRecebimento);
  const { segunda, sabado } = (inicioCustom && fimCustom)
    ? { segunda: inicioCustom, sabado: fimCustom }
    : calcularSemanaRecebimento(hoje);

  const filtros = await comRetry(
    () => configurarFiltrosLancamentos(page, { segunda, sabado }),
    (r) => r && r.ok,
    { tentativas: 6, esperaMs: 1200 }
  );
  if (!filtros || !filtros.ok) {
    await salvarDiagnostico(page, LANCAMENTOS_DIR, 'sem-filtros');
    throw new Error(`Não consegui configurar todos os filtros do Catálogo de Produtos (faltando: ${filtros ? filtros.faltando.join(', ') : 'formulário inteiro'}). Diagnóstico salvo em debug-sem-filtros.png/.json.`);
  }
  await page.waitForTimeout(500);

  const clicou = await comRetry(
    () => clicarPesquisarProduto(page),
    (ok) => ok === true,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicou) {
    await salvarDiagnostico(page, LANCAMENTOS_DIR, 'sem-botao-pesquisar');
    throw new Error('Não encontrei o botão "Pesquisar Produto". Diagnóstico salvo em debug-sem-botao-pesquisar.png/.json.');
  }

  const { linhas: linhasCruas } = await _aguardarTabelaLancamentosEstavel(page);
  const produtos = _normalizarLancamentos(linhasCruas);

  return {
    capturadoEm: new Date().toISOString(),
    periodoRecebimento: { de: formatarDataBr(segunda), ate: formatarDataBr(sabado) },
    produtos,
  };
}

function nomeBaseCaptura(snapshot) {
  const de = snapshot.periodoRecebimento.de.replace(/\//g, '-');
  const ate = snapshot.periodoRecebimento.ate.replace(/\//g, '-');
  return `captura-${de}_a_${ate}`;
}

function nomeArquivoCaptura(snapshot) {
  return path.join(LANCAMENTOS_DIR, `${nomeBaseCaptura(snapshot)}.json`);
}

function nomeArquivoXlsx(snapshot) {
  return path.join(LANCAMENTOS_DIR, `${nomeBaseCaptura(snapshot)}.xlsx`);
}

// PEDIDO DO USUÁRIO (2026-08-11): "a ideia é pegar esses lançamentos e gerar
// um arquivo... pra ficar guardado pra utilizar quando necessário" — depois
// de validar a ferramenta contra 2 semanas reais (bateu 35/36 códigos, a
// diferença foi erro humano no processo manual antigo, não bug daqui), o
// pedido agora é ter um arquivo de verdade pra guardar/compartilhar.
// Passou por 2 formatos antes deste: CSV cru (';' + BOM), depois CSV com uma
// linha de período acima do cabeçalho. Usuário testou abrindo no Excel e
// resalvando como .xlsx (mandou o arquivo de exemplo) — resultado: célula
// de período MESCLADA A1:B1 (célula única de verdade, não só texto
// "vazando" pra coluna B como um CSV faz) e colunas com largura ajustada.
// Isso não dá pra fazer num .csv (não existe célula mesclada em texto
// plano) — por isso agora gera .xlsx de verdade, com a lib exceljs, em vez
// de fingir formatação num arquivo de texto.
async function produtosParaXlsxBuffer(produtos, periodoRecebimento) {
  const workbook = new ExcelJS.Workbook();
  const planilha = workbook.addWorksheet('Lançamentos');
  planilha.getColumn(1).width = 12;
  planilha.getColumn(2).width = 75;

  planilha.mergeCells('A1:B1');
  planilha.getCell('A1').value = periodoRecebimento
    ? `Período de recebimento: ${periodoRecebimento.de} a ${periodoRecebimento.ate}`
    : '';

  planilha.getCell('A2').value = 'Código';
  planilha.getCell('B2').value = 'Descrição';

  let linha = 3;
  for (const p of produtos || []) {
    planilha.getCell(`A${linha}`).value = p.codigo;
    planilha.getCell(`B${linha}`).value = p.descricaoComercial || p.descricaoCurta || '';
    linha++;
  }

  return workbook.xlsx.writeBuffer();
}

async function salvarCaptura(snapshot) {
  garantirPastas();
  fs.writeFileSync(nomeArquivoCaptura(snapshot), JSON.stringify(snapshot, null, 2));
  const buffer = await produtosParaXlsxBuffer(snapshot.produtos, snapshot.periodoRecebimento);
  fs.writeFileSync(nomeArquivoXlsx(snapshot), buffer);
  fs.writeFileSync(ULTIMA_CAPTURA_PATH, JSON.stringify(snapshot, null, 2));
}

function carregarUltimaCaptura() {
  if (!fs.existsSync(ULTIMA_CAPTURA_PATH)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(ULTIMA_CAPTURA_PATH, 'utf8'));
    snapshot.nomeBase = nomeBaseCaptura(snapshot);
    snapshot.arquivoXlsx = `${snapshot.nomeBase}.xlsx`;
    return snapshot;
  } catch {
    return null;
  }
}

// ⚠️ Corrigido 2026-08-11: baixar o arquivo salvo em disco (era servido
// estático) vinha do jeito que ele foi gravado NA HORA DA CAPTURA — se o
// formato mudasse depois (mudou 3x seguidas: CSV cru, CSV com período,
// agora .xlsx de verdade), toda captura antiga continuava baixando
// desatualizada pra sempre, mesmo reiniciando o servidor, porque reiniciar
// só troca o CÓDIGO, não regrava os arquivos já salvos. Por isso o download
// agora (ver rota /api/lancamentos-x2/xlsx/:nomeBase em server.js) gera a
// planilha NA HORA a partir do .json (a fonte de verdade), sempre com
// produtosParaXlsxBuffer() atual — nunca fica desatualizado de novo.
function carregarCapturaPorNomeBase(nomeBase) {
  const caminhoJson = path.join(LANCAMENTOS_DIR, `${nomeBase}.json`);
  if (!fs.existsSync(caminhoJson)) return null;
  try {
    return JSON.parse(fs.readFileSync(caminhoJson, 'utf8'));
  } catch {
    return null;
  }
}

// Lista todas as capturas já feitas (uma por período de recebimento — nunca
// sobrescrevem umas às outras, diferente de ultima-captura.json) pra
// alimentar o card "Lançamentos anteriores" no painel — mesmo padrão de
// carregarExports() de x2-estoque-export.js, mas com metadados do período em
// vez de só nome/tamanho/data, porque aqui o período É o dado relevante.
//
// PEDIDO DO USUÁRIO (2026-08-11): ordenar por PERÍODO (data de início da
// captura), do mais recente pro mais antigo — não por "quando eu cliquei
// pra capturar" (capturadoEm), porque durante os testes eu capturei períodos
// fora de ordem cronológica (ex.: testei 01/07-12/07 DEPOIS de já ter
// capturado 20/07-25/07), o que deixava a lista com períodos embaralhados.
function carregarExports() {
  garantirPastas();
  return fs.readdirSync(LANCAMENTOS_DIR)
    .filter((f) => f.startsWith('captura-') && f.endsWith('.json'))
    .map((f) => {
      try {
        const snapshot = JSON.parse(fs.readFileSync(path.join(LANCAMENTOS_DIR, f), 'utf8'));
        const nomeBase = nomeBaseCaptura(snapshot);
        const caminhoXlsx = nomeArquivoXlsx(snapshot);
        return {
          nomeBase,
          arquivoXlsx: `${nomeBase}.xlsx`,
          periodoRecebimento: snapshot.periodoRecebimento,
          periodoInicio: _parseDataBr(snapshot.periodoRecebimento && snapshot.periodoRecebimento.de),
          capturadoEm: snapshot.capturadoEm,
          quantidade: (snapshot.produtos || []).length,
          bytes: fs.existsSync(caminhoXlsx) ? fs.statSync(caminhoXlsx).size : 0,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = a.periodoInicio ? a.periodoInicio.getTime() : 0;
      const tb = b.periodoInicio ? b.periodoInicio.getTime() : 0;
      return tb - ta;
    })
    .map(({ periodoInicio, ...resto }) => resto); // campo auxiliar só pra ordenar — não precisa ir pro JSON de resposta
}

async function rodar({ channel, confirmar, modoAutomatico, dataInicioRecebimento, dataFimRecebimento } = {}) {
  const context = await abrirNavegador(channel);
  try {
    if (!modoAutomatico) {
      const page = context.pages()[0] || (await context.newPage());
      if (!page.url().includes('xprocess.com.br')) await page.goto(LOGIN_URL).catch(() => {});
      console.log('\n==============================================================');
      console.log('Faça login se precisar (a sessão fica salva).');
      console.log('==============================================================\n');
      if (confirmar) {
        await confirmar('Faça login no X2 se precisar e clique em "Já cliquei, continuar" abaixo (o script cuida do resto sozinho a partir daqui).');
      } else {
        await ask('Pressione Enter DEPOIS de estar logado no X2... ');
      }
    }

    const snapshot = await capturarLancamentos(context, { modoAutomatico, dataInicioRecebimento, dataFimRecebimento });
    await salvarCaptura(snapshot);
    console.log(`Captura salva: ${snapshot.produtos.length} produto(s) novo(s) — recebimento de ${snapshot.periodoRecebimento.de} a ${snapshot.periodoRecebimento.ate}.`);
    return snapshot;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  await rodar({ channel: 'chrome' });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  LANCAMENTOS_DIR,
  ULTIMA_CAPTURA_PATH,
  formatarDataBr,
  calcularSemanaRecebimento,
  abrirCatalogoProdutosCompras,
  configurarFiltrosLancamentos,
  capturarLancamentos,
  mapearSecoesTocadas,
  produtosParaXlsxBuffer,
  salvarCaptura,
  carregarUltimaCaptura,
  carregarExports,
  carregarCapturaPorNomeBase,
  rodar,
};
