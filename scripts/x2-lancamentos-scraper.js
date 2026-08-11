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
 * Por padrão captura a semana corrente (segunda a sábado — se hoje ainda não
 * chegou no sábado, traz o que já entrou até agora). Cada execução SALVA em
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

/** Segunda a sábado da semana corrente (ou da que acabou de passar, se hoje
 * for domingo) — mesma regra do procedimento manual ("Última Segunda-Feira"
 * / "Último Sábado"). `dia`: 0=domingo..6=sábado. */
function calcularSemanaRecebimento(hoje = new Date()) {
  const dia = hoje.getDay();
  const diasDesdeSegunda = (dia + 6) % 7;
  const segunda = new Date(hoje);
  segunda.setDate(hoje.getDate() - diasDesdeSegunda);
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
 * vivo (ver cabeçalho do arquivo). */
async function configurarFiltrosLancamentos(page, { segunda, sabado } = {}) {
  const { resultado } = await avaliarEmQualquerFrame(page, ({ dtIniRec, dtFimRec }) => {
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

async function capturarLancamentos(context, { modoAutomatico, hoje = new Date() } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await abrirCatalogoProdutosCompras(page, { modoAutomatico });

  const { segunda, sabado } = calcularSemanaRecebimento(hoje);

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

function nomeArquivoCaptura(snapshot) {
  const de = snapshot.periodoRecebimento.de.replace(/\//g, '-');
  const ate = snapshot.periodoRecebimento.ate.replace(/\//g, '-');
  return path.join(LANCAMENTOS_DIR, `captura-${de}_a_${ate}.json`);
}

function salvarCaptura(snapshot) {
  garantirPastas();
  fs.writeFileSync(nomeArquivoCaptura(snapshot), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(ULTIMA_CAPTURA_PATH, JSON.stringify(snapshot, null, 2));
}

function carregarUltimaCaptura() {
  if (!fs.existsSync(ULTIMA_CAPTURA_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(ULTIMA_CAPTURA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function rodar({ channel, confirmar, modoAutomatico } = {}) {
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

    const snapshot = await capturarLancamentos(context, { modoAutomatico });
    salvarCaptura(snapshot);
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
  salvarCaptura,
  carregarUltimaCaptura,
  rodar,
};
