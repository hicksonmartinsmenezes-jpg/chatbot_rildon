#!/usr/bin/env node
/**
 * scripts/x2-painel-produtos-snapshot.js
 *
 * PEDIDO DO USUÁRIO (2026-08-06): depois de mostrar a tela "Compras >
 * Gestão de Produtos > Painel" (cards "Divergências" e "Situação" — ~24
 * contadores tipo "Sem Foto/Arquivo: 2789", "Estoque Negativo: 0" etc.),
 * perguntou se valia a pena automatizar a extração desses dados também.
 *
 * ─── Avaliação honesta que levou a essa decisão ───────────────────────────
 * Testei ao vivo (2026-08-06) clicar num dos números ("Sem Foto/Arquivo") —
 * NÃO abre lista de produtos, é só um contador estático. Também não achei
 * botão de exportar na tela. Ou seja, diferente de Estoque (que gera um CSV
 * com produto por produto), aqui só dá pra capturar os TOTAIS, não QUAIS
 * produtos. Ainda assim, decisão do usuário (2026-08-06): vale a pena como
 * "snapshot diário" — histórico de tendência (ex: "Sem Foto caiu de 3200 pra
 * 2789 essa semana") e alarme de anomalia pras métricas que deviam ser
 * sempre 0 (Estoque Negativo, Sem NCM, Sem Fornecedor, Sem Fabricante).
 *
 * ─── Tela e navegação (confirmados ao vivo 2026-08-06) ───────────────────
 * ☰ > tile "Compras" > link "Gestão de Produtos"
 * (`../cadastros/produto/gestao_produtos/painel.jsp`) > aba "Painel" (a
 * primeira aba, em "Operacional" — precisa de um clique extra, não vem
 * selecionada por padrão). Mostra dois blocos de contadores
 * ("Divergências" e "Situação") e uma tabela "Produtos Ativos" (Qtde por
 * Unidade/Empresa).
 *
 * ─── O que NÃO foi confirmado ao vivo ──────────────────────────────────
 * A extração dos números usa uma técnica GENÉRICA (acha elementos-folha
 * cujo texto é só dígitos, usa o texto do elemento-pai como rótulo) em vez
 * de seletores fixos — não deu pra inspecionar o DOM de dentro do iframe
 * pela ferramenta de leitura disponível na sessão de descoberta. Pode
 * pegar rótulo errado ou faltar alguma métrica se a estrutura real for
 * diferente do que essa heurística espera — precisa de 1ª rodada
 * supervisionada (rodar e comparar com o que aparece na tela) pra
 * confirmar.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-painel-produtos-snapshot.js
 *
 * Cada execução ACRESCENTA uma entrada (não sobrescreve) em
 * `~/.x2-rildon-scraper/painel-produtos/historico.json`, fora do OneDrive.
 * Nada além de guardar é feito — sem processar/alertar/exibir ainda (o
 * projeto de estoque/qualidade cadastral em si é futuro, decisão já
 * registrada pro Estoque e reaproveitada aqui).
 *
 * ─── Listas de qualidade cadastral (2026-08-07) ───────────────────────────
 * PEDIDO DO USUÁRIO: "no painel de gestão de produtos tem telas de itens
 * inativos, sem fotos e sem preços, acho que poderia separar alguma aba com
 * rotina para também armazenar esses dados". Quando este arquivo foi escrito
 * (2026-08-06), cliques nos badges de Divergências/Situação pareciam não
 * abrir lista nenhuma (só contador estático) — ver aviso acima. Isso estava
 * ERRADO: confirmado ao vivo em 2026-08-07 que cada badge abre um filtro
 * "<Rótulo> - Linha: <select>" e, ao escolher a opção "(N) Todas", mostra
 * uma tabela real com os produtos daquela divergência (código, cód. barras,
 * descrição, e colunas extras dependendo do tipo — ex: "Preço de Venda
 * Zerado" e "Sem Custo Médio" mostram inputs de preço/custo editáveis,
 * "Itens Inativos" mostra um botão "Ativar Produtos"). O engano anterior foi
 * de automação: um clique de mouse sintético em cima da opção do <select>
 * não disparava o evento `change` que a tela escuta — via teclado (ou via
 * `select.value = ...; dispatchEvent(new Event('change'))`, o mesmo que
 * Playwright faz internamente) funciona.
 *
 * `capturarTodasListasQualidade()` roda isso pras 4 divergências pedidas
 * (`DIVERGENCIAS_LISTAVEIS`): clica o badge, seleciona "Todas" na Linha,
 * espera a tabela carregar, extrai cabeçalho+linhas genericamente (sem
 * assumir colunas fixas, já que cada tipo tem um layout um pouco diferente),
 * e salva em `~/.x2-rildon-scraper/painel-produtos/qualidade-cadastral/
 * <chave>.json` — SOBRESCREVE a cada captura (é um retrato do estado atual
 * pro usuário visualizar, não um histórico acumulado — histórico de
 * TOTAIS por divergência já existe em historico.json via capturarMetricas).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { chromium } = require('playwright');

// Sem isso, X2_USUARIO/X2_SENHA só carregavam quando este script rodava
// DENTRO do server.js — rodando direto pelo terminal, process.env ficava
// vazio. Confirmado ao vivo 2026-08-06 (ver x2-estoque-export.js).
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const PROFILE_DIR = path.join(WORK_DIR, 'chrome-profile');
const PAINEL_PRODUTOS_DIR = path.join(WORK_DIR, 'painel-produtos');
const HISTORICO_PATH = path.join(PAINEL_PRODUTOS_DIR, 'historico.json');
const QUALIDADE_DIR = path.join(PAINEL_PRODUTOS_DIR, 'qualidade-cadastral');

// As 4 divergências que o usuário pediu pra capturar como LISTA (não só
// contador) — 2026-08-07. `labelBadge` precisa bater exatamente com o texto
// visível do badge no Painel (usado pra achar o elemento clicável).
//
// ⚠️ 2026-08-10: "Preço de Venda Zerado" e "Sem Custo Médio" saem via CSV
// agora (`viaCsv: true`), não mais pelo scrape do X2 — ver
// `capturarDivergenciasViaCsv` logo abaixo pro motivo (o scrape via UI pra
// essas duas nunca funcionou, é bug de estado reproduzido de novo ao vivo
// nessa data). "Itens Inativos" e "Sem Foto/Arquivo" continuam via UI
// porque não existe coluna de "produto inativo" nem "tem foto no X2" no CSV
// de estoque — só custo/preço estão lá.
const DIVERGENCIAS_LISTAVEIS = [
  { chave: 'itensInativos', labelBadge: 'Itens Inativos' },
  { chave: 'semFotoArquivo', labelBadge: 'Sem Foto/Arquivo' },
  { chave: 'precoVendaZerado', labelBadge: 'Preço de Venda Zerado', viaCsv: true },
  { chave: 'semCustoMedio', labelBadge: 'Sem Custo Médio', viaCsv: true },
];

const HOME_URL = 'https://sistemas7.xprocess.com.br/x2rildon/www/index_main4.jsp';
const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';
// Confirmado ao vivo 2026-08-06.
const GESTAO_PRODUTOS_HREF_MARK = 'gestao_produtos/painel.jsp';

function garantirPastas() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(PAINEL_PRODUTOS_DIR, { recursive: true });
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

async function abrirNavegador(channel) {
  garantirPastas();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless: false, viewport: null });
  // Ver x2-fotos-scraper.js pro relato completo (navigator.webdriver=true
  // confirmado ao vivo 2026-08-06 — esconde por precaução).
  const { esconderWebdriver } = require('./x2-fotos-scraper');
  await esconderWebdriver(context);
  return context;
}

async function tentarLoginAutomaticoSeNecessario(page) {
  const pareceLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (!pareceLogin) return;
  const { tentarLoginAutomatico } = require('./x2-fotos-scraper');
  await tentarLoginAutomatico(page);
}

// Navega até "Compras > Gestão de Produtos > Painel" clicando pelo menu de
// verdade (nunca por URL direta — confirmado bloqueado pelo servidor, ver
// x2-estoque-export.js pro relato completo dessa descoberta).
async function abrirPainelProdutos(page, { modoAutomatico } = {}) {
  if (modoAutomatico) {
    // ⚠️ Confirmado ao vivo 2026-08-06 (testando x2-estoque-export.js, mesmo
    // padrão): goto() direto pra HOME_URL dispara a trava de "acesso direto
    // não permitido" mesmo já logado ("Gerenciamento de Acesso / Acesso
    // Negado!"). LOGIN_URL sempre carrega direto sem bloqueio. Por isso
    // entra sempre por ali — se já tiver sessão válida, o X2 redireciona
    // sozinho pra fora da tela de login.
    await page.goto(LOGIN_URL).catch(() => {});
    await page.waitForTimeout(1000);
    await tentarLoginAutomaticoSeNecessario(page);
    await page.waitForTimeout(1000);
  }

  await page.locator('a').first().click({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.locator('a:has-text("Compras")').first().click({ timeout: 10000 });
  await page.waitForTimeout(500);
  await page.locator(`a[href*="${GESTAO_PRODUTOS_HREF_MARK}"]`).first().click({ timeout: 10000 });

  // ⚠️ CORREÇÃO 2026-08-07 #2 (achado por diagnóstico ao vivo, 2ª rodada):
  // a 1ª correção (buscar "Painel" em TODOS os frames) resolveu o problema
  // de nó-folha, mas criou um novo: existe MAIS DE UM elemento com texto
  // exato "Painel" na página inteira — inclusive um item do MENU de
  // navegação (Vendas 3.0 > Painel, tela totalmente diferente). Como o
  // clique no link "Gestão de Produtos" ainda não tinha terminado de
  // navegar (o menu lateral ainda estava aberto por cima), a busca global
  // pegou o "Painel" do MENU em vez da aba de dentro da tela — confirmado
  // pelo diagnóstico salvo (nenhum frame com URL de gestao_produtos no
  // momento do clique). Fix: espera de verdade o frame de destino
  // (`GESTAO_PRODUTOS_HREF_MARK` na URL) aparecer ANTES de procurar a aba,
  // e restringe a busca da aba a ESSE frame (+ o frame principal, caso a
  // aba em si esteja fora do iframe de conteúdo) — não mais a página
  // inteira, evitando pegar de novo um "Painel" de outro lugar.
  let frameGestaoProdutos = null;
  for (let i = 0; i < 10 && !frameGestaoProdutos; i++) {
    frameGestaoProdutos = page.frames().find((f) => f.url().includes(GESTAO_PRODUTOS_HREF_MARK)) || null;
    if (!frameGestaoProdutos) await page.waitForTimeout(500);
  }

  if (!frameGestaoProdutos) {
    await salvarDiagnostico(page, 'sem-frame-gestao-produtos');
    throw new Error(
      `Cliquei em "Gestão de Produtos" mas a tela nunca carregou (nenhum frame com "${GESTAO_PRODUTOS_HREF_MARK}" na URL depois de 5s) — ` +
      `precisa confirmar numa sessão ao vivo. Diagnóstico salvo em debug-sem-frame-gestao-produtos.png/.json.`
    );
  }
  await page.waitForTimeout(1200);

  // A aba "Painel" (dentro da tela) não vem selecionada por padrão —
  // precisa desse clique extra, confirmado ao vivo.
  //
  // ⚠️ CORREÇÃO 2026-08-07 #3: a #2 (restringir a busca a
  // `frameGestaoProdutos` + frame principal) ainda pegou o "Painel" ERRADO
  // — o do menu, que mora no frame PRINCIPAL. Diagnóstico mostrou que
  // `frameGestaoProdutos` sozinho não tinha nenhum "Painel" encontrável no
  // momento do clique (a aba de verdade deve estar num frame ANINHADO
  // dentro dele, com URL própria — `page.frames()` acha esses frames
  // aninhados numa lista achatada, então não precisamos saber a URL exata).
  // Fix definitivo: busca em TODOS os frames MENOS o principal (onde mora
  // a armadilha do menu) — nunca mais inclui `page.mainFrame()` como
  // fallback pra esse clique especificamente.
  // ⚠️ CORREÇÃO 2026-08-07 #4: a #3 achou o frame CERTO
  // (gestao_produtos/painel.jsp confirmado no diagnóstico), mas nesse
  // momento ele só tinha o TÍTULO carregado ("Gestão de Produtos") — a
  // barra de abas (Painel/Cadastro de Produtos/...) ainda não tinha
  // renderizado via AJAX. Por isso retry com espera, igual ao que já foi
  // aplicado em capturarMetricas — não dá pra confiar num wait fixo aqui.
  let clicouPainel = false;
  for (let i = 0; i < 6 && !clicouPainel; i++) {
    const frames = page.frames().filter((f) => f !== page.mainFrame());
    clicouPainel = await clicarTextoExato(page, 'Painel', { frames });
    if (!clicouPainel) await page.waitForTimeout(1000);
  }
  if (!clicouPainel) {
    // Diagnóstico: salva screenshot + textos-folha reais da tela nesse
    // momento, pra debugar sem precisar de acesso ao vivo à janela (que é
    // do Playwright, headless:false, fora do alcance do
    // Claude-in-Chrome/computer-use read-only).
    await garantirPastasDebug();
    const screenshotPath = path.join(PAINEL_PRODUTOS_DIR, 'debug-ultima-falha.png');
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const porFrame = [];
    for (const frame of page.frames()) {
      try {
        const textos = await frame.evaluate(() => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
          const textoDe = (e) => (e.tagName === 'INPUT' ? e.value : e.textContent);
          return Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], td, span, div'))
            .filter((e) => e.children.length === 0 && norm(textoDe(e)))
            .slice(0, 40)
            .map((e) => norm(textoDe(e)));
        });
        porFrame.push({ url: frame.url(), textos });
      } catch (e) {
        porFrame.push({ url: frame.url(), erro: e.message });
      }
    }
    const diagnostico = { urlPrincipal: page.url(), frames: porFrame };
    fs.writeFileSync(
      path.join(PAINEL_PRODUTOS_DIR, 'debug-ultima-falha.json'),
      JSON.stringify(diagnostico, null, 2)
    );
    throw new Error(
      `Não achei a aba "Painel" dentro de "Gestão de Produtos" — precisa confirmar numa sessão ao vivo. ` +
      `Diagnóstico salvo em debug-ultima-falha.png/.json (${porFrame.length} frame(s) na página).`
    );
  }
  await page.waitForTimeout(1200);

  // PEDIDO DO USUÁRIO (2026-08-11): "sempre que tiver um campo de unidade,
  // perceba sempre que tem 3 unidades, a matriz, a distribuidora e o
  // ecommerce, preciso que sempre verifique os 3". Confirmado pelo usuário
  // ao vivo: o select "Unidade" desta tela TEM opção "Todas" (uma nota
  // antiga no comentário de _selecionarTodasNaLinha, mais abaixo, dizia o
  // contrário — não confiar nela, foi engano/suposição não confirmada).
  // Sem isso, os contadores de Divergências/Situação e as listas de
  // Qualidade Cadastral (Itens Inativos, Sem Foto/Arquivo etc.) capturados
  // por este script podiam refletir só 1 das 3 unidades (o que quer que
  // estivesse selecionado na tela), não o total da loja. Roda logo após
  // clicar na aba "Painel" — é aqui que o select "Unidade" já existe,
  // segundo a mesma nota antiga (antes de qualquer clique em badge).
  await _selecionarUnidadeTodas(page);
}

/** Acha o select "Unidade" (Matriz/Distribuidora/Ecommerce) em qualquer
 * frame e seleciona a opção "Todas" — desambigua de outros selects da tela
 * exigindo que o texto próximo (linha/label) normalize contendo "UNIDADE".
 * Falha alto (não segue silenciosamente) se não achar, porque estoque/
 * contagem incompleta sem avisar é pior que parar a captura. */
async function _selecionarUnidadeTodas(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().replace(/\s+/g, ' ').trim();
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const linha = sel.closest('tr') || sel.parentElement;
      const rotulo = linha ? norm(linha.textContent) : '';
      if (!rotulo.includes('UNIDADE')) continue;
      const optTodas = Array.from(sel.options).find((o) => norm(o.textContent).includes('TODAS'));
      if (!optTodas) continue;
      sel.value = optTodas.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    return null;
  });
  if (!resultado || !resultado.ok) {
    await salvarDiagnostico(page, 'sem-select-unidade');
    throw new Error(
      'Não achei um select "Unidade" com opção "Todas" em nenhum frame — precisa confirmar numa sessão ao vivo ' +
      '(usuário confirmou que esse campo existe nesta tela). Diagnóstico salvo em debug-sem-select-unidade.png/.json.'
    );
  }
}

/** Salva screenshot + textos-folha de todos os frames pra debug (usado
 * quando alguma extração pós-navegação falha — clique certo, mas conteúdo
 * ainda não achado). */
async function salvarDiagnostico(page, sufixo) {
  await garantirPastasDebug();
  await page.screenshot({ path: path.join(PAINEL_PRODUTOS_DIR, `debug-${sufixo}.png`), fullPage: true }).catch(() => {});
  const porFrame = [];
  for (const frame of page.frames()) {
    try {
      const textos = await frame.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const textoDe = (e) => (e.tagName === 'INPUT' ? e.value : e.textContent);
        return Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], td, span, div'))
          .filter((e) => e.children.length === 0 && norm(textoDe(e)))
          .slice(0, 60)
          .map((e) => norm(textoDe(e)));
      });
      porFrame.push({ url: frame.url(), textos });
    } catch (e) {
      porFrame.push({ url: frame.url(), erro: e.message });
    }
  }
  fs.writeFileSync(
    path.join(PAINEL_PRODUTOS_DIR, `debug-${sufixo}.json`),
    JSON.stringify({ urlPrincipal: page.url(), frames: porFrame }, null, 2)
  );
}

/** Roda `tentativa` várias vezes com espera crescente entre elas, até ela
 * devolver algo que passe em `estaOk`. A tela de Gestão de Produtos carrega
 * o conteúdo do "Painel" via AJAX depois do clique na aba — um `waitForTimeout`
 * fixo de 1200ms nem sempre é suficiente (confirmado ao vivo 2026-08-07: o
 * clique na aba funcionou mas os contadores ainda não tinham renderizado). */
async function comRetry(tentativa, estaOk, { tentativas = 5, esperaMs = 1000 } = {}) {
  let ultimoResultado;
  for (let i = 0; i < tentativas; i++) {
    ultimoResultado = await tentativa();
    if (estaOk(ultimoResultado)) return ultimoResultado;
    await new Promise((resolve) => setTimeout(resolve, esperaMs));
  }
  return ultimoResultado;
}

function garantirPastasDebug() {
  fs.mkdirSync(PAINEL_PRODUTOS_DIR, { recursive: true });
}

// ─── Helpers de frame robustos (2026-08-07) ────────────────────────────────
// A suposição antiga era que o conteúdo sempre mora em
// `iframe[name="principal"]` e que elementos clicáveis são sempre nós-folha
// (`children.length === 0`). Diagnóstico ao vivo mostrou os dois errados
// pra essa tela específica (Gestão de Produtos): o botão "Painel" tem
// markup aninhado dentro (não é folha), e não foi possível confirmar que o
// conteúdo real mora só em "principal". Esses helpers resolvem os dois
// problemas de vez: varrem TODOS os frames da página, e acham o elemento
// mais "interno" (menos descendentes) entre os que batem o texto exato —
// não exige que ele mesmo não tenha filhos.

/** Clica no elemento cujo texto (normalizado, sem acento) bate exatamente
 * com `texto`, procurando em todos os frames da página. Entre os elementos
 * que batem, escolhe o com MENOS elementos-descendentes (o mais específico
 * — evita clicar num container grande que só por acaso contém aquele texto
 * inteiro). Retorna o Frame onde clicou, ou null se não achou em nenhum. */
async function clicarTextoExato(page, texto, { frames } = {}) {
  for (const frame of frames || page.frames()) {
    try {
      const clicou = await frame.evaluate((alvo) => {
        const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
        // ⚠️ CORREÇÃO 2026-08-07 #5: a #4 (retry com espera) não resolveu —
        // porque o problema nunca foi timing. A barra de abas real é feita
        // de `<input type="button" value="Painel">` (confirmado pela
        // screenshot mostrando os botões, contra o diagnóstico de texto
        // sempre vazio pra esse frame). `<input>` NÃO tem `textContent`
        // pro seu rótulo visível — o texto mora em `.value`. `textoDe()`
        // cobre os dois casos.
        const textoDe = (e) => (e.tagName === 'INPUT' ? e.value : e.textContent);
        const alvoNorm = norm(alvo);
        const candidatos = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], td, span, div, li'))
          .filter((e) => norm(textoDe(e)) === alvoNorm);
        if (candidatos.length === 0) return false;
        candidatos.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
        candidatos[0].click();
        return true;
      }, texto);
      if (clicou) return frame;
    } catch (e) {
      // frame cross-origin ou destruído no meio da navegação — ignora e
      // tenta o próximo.
    }
  }
  return null;
}

/** Roda `avaliador` em todos os frames da página, retorna o resultado do
 * PRIMEIRO frame em que `avaliador` devolver algo "truthy" (ou um objeto
 * marcado com `.ok !== false` e conteúdo não-vazio, dependendo do chamador
 * — cada avaliador já filtra isso internamente). */
async function avaliarEmQualquerFrame(page, avaliador, arg) {
  for (const frame of page.frames()) {
    try {
      const resultado = await frame.evaluate(avaliador, arg);
      if (resultado) return { frame, resultado };
    } catch (e) {
      // idem — ignora frame problemático e segue.
    }
  }
  return { frame: null, resultado: null };
}

// Extrai os pares rótulo→número dos cards "Divergências"/"Situação".
// Técnica GENÉRICA (ver aviso no cabeçalho): acha elementos-folha (sem
// filhos) cujo texto é só dígitos/pontuação, e usa o texto do elemento-pai
// (menos o número) como rótulo — casa com o padrão visual observado
// (barra escura com rótulo + badge colorido com número, lado a lado).
async function capturarMetricas(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    // Mesma correção de `<input value="...">` aplicada em clicarTextoExato
    // — alguns contadores podem estar em inputs readonly, não texto puro.
    const textoDe = (e) => (e.tagName === 'INPUT' ? e.value : e.textContent);
    const metricas = {};
    const todos = Array.from(document.querySelectorAll('*'));
    for (const el of todos) {
      if (el.children.length > 0) continue;
      const texto = (textoDe(el) || '').trim();
      if (!/^\d[\d.,]*$/.test(texto)) continue;
      const pai = el.parentElement;
      if (!pai) continue;
      const textoContainer = (pai.textContent || '').trim();
      const rotulo = textoContainer.replace(texto, '').trim();
      if (rotulo && rotulo.length > 1 && rotulo.length < 60) {
        metricas[rotulo] = Number(texto.replace(/\./g, '').replace(',', '.'));
      }
    }
    return Object.keys(metricas).length ? { ok: true, metricas } : null;
  });
  return resultado || { ok: false, erro: 'Não achei nenhum contador numérico em nenhum frame da página.' };
}

// Extrai a tabela "Produtos Ativos" (Unidade / Qtde).
async function capturarProdutosAtivos(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const tabelas = Array.from(document.querySelectorAll('table'));
    for (const t of tabelas) {
      const primeiraLinha = t.querySelector('tr');
      const headerTexto = primeiraLinha ? primeiraLinha.textContent.toUpperCase() : '';
      if (headerTexto.includes('UNIDADE') && headerTexto.includes('QTDE')) {
        const linhas = Array.from(t.querySelectorAll('tr')).slice(1);
        const linhasExtraidas = linhas
          .map((tr) => {
            const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
            return { unidade: tds[0] || null, qtde: tds[1] ? Number(tds[1].replace(/\./g, '')) : null };
          })
          .filter((r) => r.unidade);
        if (linhasExtraidas.length) return linhasExtraidas;
      }
    }
    return null;
  });
  return resultado || [];
}

// ─── Listas de qualidade cadastral (2026-08-07, ver comentário no topo) ────

// Clica no badge de uma divergência/situação, procurando em todos os
// frames e escolhendo o elemento mais interno que bate o texto exato —
// mesma técnica de `clicarTextoExato` usada pro clique na aba "Painel".
async function _clicarBadgeDivergencia(page, labelBadge) {
  // Mesma proteção usada pra aba "Painel": nunca procurar no frame
  // principal (é onde mora o item de menu que pode ter texto parecido).
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  const frame = await clicarTextoExato(page, labelBadge, { frames });
  return !!frame;
}

// Depois do clique no badge, aparece um <select> "<Rótulo> - Linha:" com
// opções tipo "(47) ABRAÇADEIRA DE AÇO" e uma "(N) Todas" no topo. Achar
// esse select pela PRESENÇA da opção "Todas" (o select "Unidade", que já
// existe na tela antes do clique, não tem essa opção) evita depender de
// id/name que não foram confirmados no DOM real.
//
// ⚠️ Setar `.value` + disparar 'change' via JS é o que corrige o engano de
// 2026-08-06: um clique de mouse sintético na opção da lista NÃO disparava
// o listener da tela (comprovado ao vivo); via teclado (seta+Enter) ou via
// isso aqui (equivalente ao que Playwright faz internamente com
// `selectOption`) funciona.
async function _selecionarTodasNaLinha(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const selects = Array.from(document.querySelectorAll('select'));
    for (const sel of selects) {
      const opcaoTodas = Array.from(sel.options).find((o) => /\(\d+\)\s*todas/i.test(o.textContent));
      if (opcaoTodas) {
        sel.value = opcaoTodas.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  });
  return !!resultado;
}

// Extrai a tabela de resultado de forma genérica (cada divergência tem
// colunas diferentes — ex: "Itens Inativos" tem checkbox+Ativar Produtos,
// "Preço de Venda Zerado"/"Sem Custo Médio" têm inputs de preço editáveis
// em vez de texto puro). Não assume nomes de coluna fixos: pega cabeçalho +
// linhas como arrays de texto, lendo `.value` quando a célula for um input.
//
// ⚠️ CORREÇÃO 2026-08-10: antes retornava a PRIMEIRA tabela que batesse o
// header (DESCRI/CÓDIGO) e tivesse pelo menos 1 produto — confirmado ao
// vivo (2x, em sessões diferentes) que isso pega uma tabela pequena/decoy
// (ex: um resumo de filtro com só 1 linha) antes da tabela real (que tem
// milhares de linhas) terminar de carregar via AJAX. Sintoma observado:
// "Itens Inativos" sempre captura exatamente 1 produto quando o X2 mostra
// 8.635 no contador. Fix: entre TODAS as tabelas candidatas (mesmo
// critério de header), fica com a MAIOR — e quem chama isso
// (`_aguardarTabelaResultadoEstavel`) faz polling até essa contagem parar
// de crescer, em vez de aceitar o primeiro resultado não-vazio.
async function _scrapearTabelaResultado(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const tabelas = Array.from(document.querySelectorAll('table'));
    let melhor = null;
    for (const t of tabelas) {
      const primeiraLinha = t.querySelector('tr');
      if (!primeiraLinha) continue;
      const headerTexto = primeiraLinha.textContent.toUpperCase();
      if (!headerTexto.includes('DESCRI') && !headerTexto.includes('CÓDIGO') && !headerTexto.includes('CODIGO')) continue;

      const linhas = Array.from(t.querySelectorAll('tr'));
      const headers = Array.from(linhas[0].querySelectorAll('th, td')).map((c) => c.textContent.trim());
      const produtos = linhas.slice(1)
        .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => {
          const input = td.querySelector('input[type="text"], input:not([type])');
          if (input) return input.value;
          return td.textContent.trim();
        }))
        .filter((celulas) => celulas.some((c) => c));
      if (produtos.length && (!melhor || produtos.length > melhor.produtos.length)) {
        melhor = { headers, produtos };
      }
    }
    return melhor;
  });
  return resultado || { headers: [], produtos: [] };
}

// 2026-08-10: mesma técnica de `aguardarTabelaEstavel` em
// x2-estoque-export.js (já validada ao vivo pra corrigir o export de
// Estoque intermitente) — em vez de aceitar a 1ª contagem não-zero (que
// pode ser uma tabela ainda carregando), faz polling até a contagem da
// MAIOR tabela candidata parar de crescer por `estabilidadeMs` seguidos.
async function _aguardarTabelaResultadoEstavel(page, { timeoutMs = 25000, intervaloMs = 500, estabilidadeMs = 1500 } = {}) {
  const inicio = Date.now();
  let melhor = { headers: [], produtos: [] };
  let ultimaContagem = -1;
  let desdeQuandoEstavel = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const atual = await _scrapearTabelaResultado(page);
    if (atual.produtos.length >= melhor.produtos.length) melhor = atual;
    if (atual.produtos.length !== ultimaContagem) {
      ultimaContagem = atual.produtos.length;
      desdeQuandoEstavel = Date.now();
    } else if (ultimaContagem > 0 && Date.now() - desdeQuandoEstavel >= estabilidadeMs) {
      return melhor;
    }
    await page.waitForTimeout(intervaloMs);
  }
  return melhor; // timeout — devolve o melhor que já achou, mesmo sem confirmar estabilidade
}

// Volta o painel pro estado inicial (badges de Divergências/Situação
// visíveis) — depois de abrir uma lista, o painel de conteúdo troca pra
// mostrar só aquela lista, precisa clicar "Painel" de novo pra resetar
// antes de capturar a próxima divergência.
//
// ⚠️ 2026-08-07/2026-08-10: reset "in-place" (só clicar "Painel" de novo)
// não limpa o estado direito — confirmado ao vivo 2x que a divergência
// clicada IMEDIATAMENTE DEPOIS de outra sempre falha em achar o select
// "Linha" (a 1ª clicada da rodada sempre funciona, a 2ª sempre falha,
// não é timing). Em vez de continuar debugando esse reset in-place,
// `capturarTodasListasQualidade` agora re-navega do zero
// (`abrirPainelProdutos`) antes de CADA divergência via UI, então esta
// função só é mantida pro caso de uso avulso (`investigarBotaoImprimir`).
async function _voltarParaPainel(page) {
  // Mesma proteção da correção #3 em abrirPainelProdutos: nunca buscar
  // "Painel" no frame principal (tem o item do menu com o mesmo texto).
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  await clicarTextoExato(page, 'Painel', { frames });
  await page.waitForTimeout(1200);
}

function _salvarListaQualidade(chave, snapshot) {
  fs.mkdirSync(QUALIDADE_DIR, { recursive: true });
  fs.writeFileSync(path.join(QUALIDADE_DIR, `${chave}.json`), JSON.stringify(snapshot, null, 2));
}

/** Lê a última captura salva pra uma divergência (ou null se nunca rodou). */
function carregarListaQualidade(chave) {
  const caminho = path.join(QUALIDADE_DIR, `${chave}.json`);
  if (!fs.existsSync(caminho)) return null;
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
}

/** Captura a lista completa de uma única divergência (clica, seleciona
 * "Todas", espera, extrai). Não volta pro Painel sozinha — quem chama
 * decide quando resetar (capturarTodasListasQualidade faz isso no finally). */
async function capturarListaDivergencia(page, { chave, labelBadge }) {
  // ⚠️ 2026-08-07: mesma classe de bug já corrigida em capturarMetricas —
  // cada passo (clicar badge, achar o select "Linha", ler a tabela) depende
  // de conteúdo carregado via AJAX que nem sempre está pronto no momento
  // exato do wait fixo seguinte. "Itens Inativos" funcionou de primeira
  // numa rodada mas com resultado suspeito (1 produto só, tela sabidamente
  // tem milhares) — indício de que _scrapearTabelaResultado pode ter
  // pegado uma tabela errada/pequena antes da real carregar. Envolvendo os
  // 3 passos em retry, igual ao resto do arquivo.
  const clicou = await comRetry(
    () => _clicarBadgeDivergencia(page, labelBadge),
    (ok) => ok === true,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicou) throw new Error(`Não encontrei o badge "${labelBadge}" no Painel.`);
  await page.waitForTimeout(800);

  const selecionou = await comRetry(
    () => _selecionarTodasNaLinha(page),
    (ok) => ok === true,
    { tentativas: 5, esperaMs: 1000 }
  );
  if (!selecionou) {
    // ⚠️ 2026-08-07: retry (5x1s) não resolveu quando a divergência não é
    // a 1ª clicada na MESMA navegação — bug de estado que resistiu a
    // várias tentativas de fix in-place. Resolvido em 2026-08-10 fazendo
    // `capturarTodasListasQualidade` re-navegar do zero (abrirPainelProdutos)
    // antes de CADA divergência via UI, então esse erro não deveria mais
    // acontecer na prática — mantido como rede de segurança.
    await salvarDiagnostico(page, `sem-select-${chave}`);
    throw new Error(`Não encontrei o filtro "Linha" (com opção "Todas") pra "${labelBadge}". Diagnóstico salvo em debug-sem-select-${chave}.png/.json.`);
  }
  await page.waitForTimeout(1000);

  // 2026-08-10: polling de estabilidade (ver _aguardarTabelaResultadoEstavel)
  // em vez de aceitar a 1ª contagem não-zero — corrige "Itens Inativos"
  // sempre capturando 1 produto quando o X2 mostra milhares.
  const { headers, produtos } = await _aguardarTabelaResultadoEstavel(page);
  if (!produtos.length) {
    await salvarDiagnostico(page, `tabela-vazia-${chave}`);
  }
  return { chave, labelBadge, capturadoEm: new Date().toISOString(), headers, produtos };
}

/** 2026-08-10 (sugestão do usuário, testando ao vivo): o scrape via UI de
 * "Preço de Venda Zerado" e "Sem Custo Médio" está quebrado desde 2026-08-07
 * (o <select> "Linha" só é achado pra 1ª divergência clicada da rodada —
 * "Itens Inativos" — as demais falham sempre, mesmo com retry; suspeita
 * documentada em `capturarListaDivergencia` de que `_voltarParaPainel` não
 * limpa o estado direito entre uma divergência e a próxima. Reproduzido ao
 * vivo de novo nessa data, ainda sem causa raiz confirmada).
 *
 * Só que essas duas divergências não precisam do X2 pra nada: o CSV do
 * Relatório de Estoque que já baixamos (x2-estoque-export.js, via
 * estoque.service.parseCsvEstoque) já traz `custoMedio` e
 * `precoVendaVarejo`/`precoVendaAtacado` por produto. Em vez de brigar mais
 * com o scrape, calcula direto do CSV mais recente — zero Playwright, zero
 * flakiness. "Preço de Venda Zerado" considera preço de varejo zerado ou
 * ausente na coluna; "Sem Custo Médio" considera custo médio zerado ou
 * ausente. Lança erro se a coluna correspondente não existir em NENHUMA
 * linha do CSV (em vez de silenciosamente marcar tudo como zerado, que
 * indicaria cabeçalho não reconhecido, não divergência real). */
function capturarDivergenciasViaCsv() {
  const { ESTOQUE_DIR, carregarExports } = require('./x2-estoque-export');
  const { parseCsvEstoque } = require('../src/services/estoque.service');

  const exports = carregarExports();
  if (!exports.length) {
    throw new Error('Nenhum export de estoque encontrado ainda (aba Estoque) — precisa de pelo menos 1 CSV pra calcular isso.');
  }
  const nomeCsv = exports[0].nome;
  const conteudo = fs.readFileSync(path.join(ESTOQUE_DIR, nomeCsv), 'utf8');
  const registros = parseCsvEstoque(conteudo);

  const temColunaVarejo = registros.some((r) => r.precoVendaVarejo !== null);
  const temColunaCusto = registros.some((r) => r.custoMedio !== null);
  if (!temColunaVarejo) throw new Error(`CSV "${nomeCsv}" não tem coluna de Preço Varejo reconhecida — não dá pra calcular "Preço de Venda Zerado".`);
  if (!temColunaCusto) throw new Error(`CSV "${nomeCsv}" não tem coluna de Custo Médio reconhecida — não dá pra calcular "Sem Custo Médio".`);

  const precoVendaZerado = registros.filter((r) => !r.precoVendaVarejo);
  const semCustoMedio = registros.filter((r) => !r.custoMedio);
  const agora = new Date().toISOString();

  _salvarListaQualidade('precoVendaZerado', {
    chave: 'precoVendaZerado',
    labelBadge: 'Preço de Venda Zerado',
    fonte: 'csv-estoque',
    csvUsado: nomeCsv,
    capturadoEm: agora,
    headers: ['Código', 'Descrição', 'Preço Varejo', 'Preço Atacado'],
    produtos: precoVendaZerado.map((r) => [r.codigo, r.descricao, r.precoVendaVarejo ?? 0, r.precoVendaAtacado ?? 0]),
  });
  _salvarListaQualidade('semCustoMedio', {
    chave: 'semCustoMedio',
    labelBadge: 'Sem Custo Médio',
    fonte: 'csv-estoque',
    csvUsado: nomeCsv,
    capturadoEm: agora,
    headers: ['Código', 'Descrição', 'Custo Médio'],
    produtos: semCustoMedio.map((r) => [r.codigo, r.descricao, r.custoMedio ?? 0]),
  });

  return {
    precoVendaZerado: { total: precoVendaZerado.length },
    semCustoMedio: { total: semCustoMedio.length },
  };
}

/** Roda capturarListaDivergencia pras divergências que ainda dependem do X2
 * (`viaCsv` não marcado) + capturarDivergenciasViaCsv pras que saem do CSV,
 * salvando cada uma (sobrescreve o arquivo anterior — é um retrato do
 * estado atual, não histórico acumulado). Erros em uma divergência não
 * impedem as outras.
 *
 * ⚠️ 2026-08-10: pedido do usuário pra corrigir "Itens Inativos" e "Sem
 * Foto/Arquivo" de vez (mostrando print do X2 com 8.635 e 2.782 — bem
 * longe do que a captura vinha trazendo: 1 e erro). Duas causas raiz
 * diferentes, corrigidas juntas:
 * 1) `_scrapearTabelaResultado` pegava a 1ª tabela pequena que batesse o
 *    header, antes da tabela real (milhares de linhas) terminar de
 *    carregar via AJAX — agora usa `_aguardarTabelaResultadoEstavel`
 *    (mesma técnica de polling já validada no export de Estoque).
 * 2) A 2ª divergência clicada na MESMA navegação sempre falhava em achar
 *    o select "Linha" — bug de estado no reset in-place
 *    (`_voltarParaPainel`) que resistiu a várias tentativas de fix
 *    pontual. Em vez de continuar caçando esse bug, cada divergência via
 *    UI agora RE-NAVEGA do zero (`abrirPainelProdutos`) antes de clicar —
 *    mais lento (repete o menu inteiro a cada uma), mas sempre parte do
 *    mesmo estado "limpo" que já comprovadamente funciona pra 1ª
 *    divergência de qualquer rodada. */
async function capturarTodasListasQualidade(page, { modoAutomatico } = {}) {
  const resultados = {};
  for (const cfg of DIVERGENCIAS_LISTAVEIS.filter((c) => !c.viaCsv)) {
    try {
      console.log(`Voltando pro Painel do zero antes de "${cfg.labelBadge}"...`);
      await abrirPainelProdutos(page, { modoAutomatico });
      console.log(`Capturando lista: ${cfg.labelBadge}...`);
      const snap = await capturarListaDivergencia(page, cfg);
      _salvarListaQualidade(cfg.chave, snap);
      resultados[cfg.chave] = { total: snap.produtos.length };
      console.log(`  -> ${snap.produtos.length} produto(s) capturado(s).`);
    } catch (e) {
      console.log(`  -> falhou (${cfg.labelBadge}): ${e.message}`);
      resultados[cfg.chave] = { erro: e.message };
    }
  }

  try {
    console.log('Calculando "Preço de Venda Zerado" e "Sem Custo Médio" a partir do CSV de estoque...');
    const viaCsv = capturarDivergenciasViaCsv();
    Object.assign(resultados, viaCsv);
    console.log(`  -> Preço de Venda Zerado: ${viaCsv.precoVendaZerado.total} | Sem Custo Médio: ${viaCsv.semCustoMedio.total}`);
  } catch (e) {
    console.log(`  -> falhou (via CSV): ${e.message}`);
    resultados.precoVendaZerado = { erro: e.message };
    resultados.semCustoMedio = { erro: e.message };
  }

  return resultados;
}

function carregarHistorico() {
  garantirPastas();
  if (!fs.existsSync(HISTORICO_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function salvarSnapshot(snapshot) {
  const historico = carregarHistorico();
  historico.push(snapshot);
  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
}

async function capturarSnapshot(context, { modoAutomatico } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await abrirPainelProdutos(page, { modoAutomatico });

  console.log('Capturando métricas...');
  // ⚠️ 2026-08-07: confirmado ao vivo que o clique na aba "Painel" pode
  // funcionar (navegação certa) mas o conteúdo (contadores) ainda não ter
  // renderizado via AJAX no momento da extração — daí o retry com espera
  // crescente em vez de um waitForTimeout fixo só.
  const resultado = await comRetry(
    () => capturarMetricas(page),
    (r) => r && r.ok,
    { tentativas: 6, esperaMs: 1500 }
  );
  if (!resultado.ok) {
    await salvarDiagnostico(page, 'sem-metricas');
    throw new Error(`${resultado.erro} Diagnóstico salvo em debug-sem-metricas.png/.json.`);
  }

  const produtosAtivos = await capturarProdutosAtivos(page);

  // Listas de qualidade cadastral (2026-08-07) — pedido do usuário. Roda
  // DEPOIS de capturar métricas/produtos ativos porque clicar nos badges
  // troca o conteúdo do painel; se desse erro aqui os dados já capturados
  // acima não se perdem.
  const listasQualidade = await capturarTodasListasQualidade(page, { modoAutomatico });

  const snapshot = {
    capturadoEm: new Date().toISOString(),
    metricas: resultado.metricas,
    produtosAtivos,
    listasQualidadeResumo: listasQualidade,
  };
  salvarSnapshot(snapshot);

  console.log(`Snapshot salvo: ${Object.keys(resultado.metricas).length} métricas, ${produtosAtivos.length} unidade(s) em Produtos Ativos.`);
  console.log(`Histórico em: ${HISTORICO_PATH}`);
  return snapshot;
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
    return await capturarSnapshot(context, { modoAutomatico });
  } finally {
    await context.close().catch(() => {});
  }
}

/** Investigação pontual (2026-08-07, sugestão do usuário): a tela de cada
 * divergência tem um botão/link "Imprimir Itens" quando "Todas" está
 * selecionado. Em vez de continuar debugando o select+scrape (que tem um
 * bug de estado entre uma divergência e outra — a 1ª funciona com contagem
 * suspeita, as 3 seguintes nem acham o select), vale checar se
 * "Imprimir Itens" gera uma página/relatório mais simples de extrair (sem
 * o jogo de estado do select). Essa função só ACHA o elemento e reporta
 * atributos (tag, href, onclick, target) — não clica, pra não disparar uma
 * janela de impressão ou download sem eu saber o que esperar primeiro.
 */
async function investigarBotaoImprimir({ channel } = {}) {
  const context = await abrirNavegador(channel);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await abrirPainelProdutos(page, { modoAutomatico: true });

    const clicou = await comRetry(
      () => _clicarBadgeDivergencia(page, 'Itens Inativos'),
      (ok) => ok === true,
      { tentativas: 4, esperaMs: 800 }
    );
    if (!clicou) throw new Error('Não achei o badge "Itens Inativos" pra investigar.');
    await page.waitForTimeout(800);

    const selecionou = await comRetry(
      () => _selecionarTodasNaLinha(page),
      (ok) => ok === true,
      { tentativas: 5, esperaMs: 1000 }
    );
    if (!selecionou) throw new Error('Não achei o filtro "Linha" pra investigar o botão Imprimir.');
    await page.waitForTimeout(1500);

    await garantirPastasDebug();
    await page.screenshot({ path: path.join(PAINEL_PRODUTOS_DIR, 'debug-investigar-imprimir.png'), fullPage: true }).catch(() => {});

    const porFrame = [];
    for (const frame of page.frames()) {
      try {
        const achados = await frame.evaluate(() => {
          const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
          const textoDe = (e) => (e.tagName === 'INPUT' ? e.value : e.textContent);
          return Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], td, span, div, li'))
            .filter((e) => norm(textoDe(e)).includes('IMPRIMIR'))
            .map((e) => ({
              tag: e.tagName,
              texto: (textoDe(e) || '').trim(),
              href: e.getAttribute('href') || null,
              onclick: e.getAttribute('onclick') || null,
              target: e.getAttribute('target') || null,
              id: e.id || null,
              classe: e.className || null,
            }));
        });
        if (achados.length) porFrame.push({ url: frame.url(), achados });
      } catch (e) {
        // frame problemático, ignora
      }
    }
    fs.writeFileSync(
      path.join(PAINEL_PRODUTOS_DIR, 'debug-investigar-imprimir.json'),
      JSON.stringify({ frames: porFrame }, null, 2)
    );
    console.log(`Investigação salva: ${porFrame.reduce((n, f) => n + f.achados.length, 0)} elemento(s) com "Imprimir" achado(s).`);
    return porFrame;
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
  WORK_DIR,
  PAINEL_PRODUTOS_DIR,
  HISTORICO_PATH,
  QUALIDADE_DIR,
  DIVERGENCIAS_LISTAVEIS,
  carregarHistorico,
  salvarSnapshot,
  carregarListaQualidade,
  capturarListaDivergencia,
  capturarDivergenciasViaCsv,
  capturarTodasListasQualidade,
  _scrapearTabelaResultado,
  _aguardarTabelaResultadoEstavel,
  _selecionarUnidadeTodas,
  investigarBotaoImprimir,
  rodar,
};
