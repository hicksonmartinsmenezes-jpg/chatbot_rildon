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
const DIVERGENCIAS_LISTAVEIS = [
  { chave: 'itensInativos', labelBadge: 'Itens Inativos' },
  { chave: 'semFotoArquivo', labelBadge: 'Sem Foto/Arquivo' },
  { chave: 'precoVendaZerado', labelBadge: 'Preço de Venda Zerado' },
  { chave: 'semCustoMedio', labelBadge: 'Sem Custo Médio' },
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
  await page.waitForTimeout(1200);

  // A aba "Painel" (dentro da tela, no iframe) não vem selecionada por
  // padrão — precisa desse clique extra, confirmado ao vivo.
  const clicouPainel = await page.evaluate(() => {
    const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const els = Array.from(doc.querySelectorAll('button, a, input[type="button"], td, span, div'));
    const el = els.find((e) => e.children.length === 0 && norm(e.textContent) === 'PAINEL');
    if (!el) return false;
    el.click();
    return true;
  });
  if (!clicouPainel) {
    throw new Error('Não achei a aba "Painel" dentro de "Gestão de Produtos" — precisa confirmar numa sessão ao vivo.');
  }
  await page.waitForTimeout(1200);
}

// Extrai os pares rótulo→número dos cards "Divergências"/"Situação".
// Técnica GENÉRICA (ver aviso no cabeçalho): acha elementos-folha (sem
// filhos) cujo texto é só dígitos/pontuação, e usa o texto do elemento-pai
// (menos o número) como rótulo — casa com o padrão visual observado
// (barra escura com rótulo + badge colorido com número, lado a lado).
async function capturarMetricas(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    if (!doc) return { ok: false, erro: 'iframe "principal" não encontrado.' };

    const metricas = {};
    const todos = Array.from(doc.querySelectorAll('*'));
    for (const el of todos) {
      if (el.children.length > 0) continue;
      const texto = (el.textContent || '').trim();
      if (!/^\d[\d.,]*$/.test(texto)) continue;
      const pai = el.parentElement;
      if (!pai) continue;
      const textoContainer = (pai.textContent || '').trim();
      const rotulo = textoContainer.replace(texto, '').trim();
      if (rotulo && rotulo.length > 1 && rotulo.length < 60) {
        metricas[rotulo] = Number(texto.replace(/\./g, '').replace(',', '.'));
      }
    }
    return { ok: true, metricas };
  });
}

// Extrai a tabela "Produtos Ativos" (Unidade / Qtde).
async function capturarProdutosAtivos(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    if (!doc) return [];
    const tabelas = Array.from(doc.querySelectorAll('table'));
    for (const t of tabelas) {
      const primeiraLinha = t.querySelector('tr');
      const headerTexto = primeiraLinha ? primeiraLinha.textContent.toUpperCase() : '';
      if (headerTexto.includes('UNIDADE') && headerTexto.includes('QTDE')) {
        const linhas = Array.from(t.querySelectorAll('tr')).slice(1);
        return linhas
          .map((tr) => {
            const tds = Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim());
            return { unidade: tds[0] || null, qtde: tds[1] ? Number(tds[1].replace(/\./g, '')) : null };
          })
          .filter((r) => r.unidade);
      }
    }
    return [];
  });
}

// ─── Listas de qualidade cadastral (2026-08-07, ver comentário no topo) ────

// Clica no badge de uma divergência/situação (elemento-folha cujo texto
// bate exatamente com o rótulo) — mesma técnica de leaf-node já usada pro
// clique na aba "Painel" logo abaixo, e pro parsing genérico em
// capturarMetricas().
async function _clicarBadgeDivergencia(page, labelBadge) {
  return page.evaluate((label) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const alvo = norm(label);
    const todos = Array.from(doc.querySelectorAll('*'));
    for (const el of todos) {
      if (el.children.length > 0) continue;
      if (norm(el.textContent) === alvo) {
        el.click();
        return true;
      }
    }
    return false;
  }, labelBadge);
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
  return page.evaluate(() => {
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const selects = Array.from(doc.querySelectorAll('select'));
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
}

// Extrai a tabela de resultado de forma genérica (cada divergência tem
// colunas diferentes — ex: "Itens Inativos" tem checkbox+Ativar Produtos,
// "Preço de Venda Zerado"/"Sem Custo Médio" têm inputs de preço editáveis
// em vez de texto puro). Não assume nomes de coluna fixos: pega cabeçalho +
// linhas como arrays de texto, lendo `.value` quando a célula for um input.
async function _scrapearTabelaResultado(page) {
  return page.evaluate(() => {
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    const tabelas = Array.from(doc.querySelectorAll('table'));
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
      return { headers, produtos };
    }
    return { headers: [], produtos: [] };
  });
}

// Volta o painel pro estado inicial (badges de Divergências/Situação
// visíveis) — depois de abrir uma lista, o painel de conteúdo troca pra
// mostrar só aquela lista, precisa clicar "Painel" de novo pra resetar
// antes de capturar a próxima divergência.
async function _voltarParaPainel(page) {
  await page.evaluate(() => {
    const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
    const els = Array.from(document.querySelectorAll('button, a, input[type="button"], td, span, div'));
    const el = els.find((e) => e.children.length === 0 && norm(e.textContent) === 'PAINEL');
    if (el) el.click();
  });
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
  const clicou = await _clicarBadgeDivergencia(page, labelBadge);
  if (!clicou) throw new Error(`Não encontrei o badge "${labelBadge}" no Painel.`);
  await page.waitForTimeout(800);

  const selecionou = await _selecionarTodasNaLinha(page);
  if (!selecionou) throw new Error(`Não encontrei o filtro "Linha" (com opção "Todas") pra "${labelBadge}".`);
  await page.waitForTimeout(1500);

  const { headers, produtos } = await _scrapearTabelaResultado(page);
  return { chave, labelBadge, capturadoEm: new Date().toISOString(), headers, produtos };
}

/** Roda capturarListaDivergencia pras 4 divergências configuradas, salvando
 * cada uma (sobrescreve o arquivo anterior — é um retrato do estado atual,
 * não histórico acumulado). Erros em uma divergência não impedem as outras. */
async function capturarTodasListasQualidade(page) {
  const resultados = {};
  for (const cfg of DIVERGENCIAS_LISTAVEIS) {
    try {
      console.log(`Capturando lista: ${cfg.labelBadge}...`);
      const snap = await capturarListaDivergencia(page, cfg);
      _salvarListaQualidade(cfg.chave, snap);
      resultados[cfg.chave] = { total: snap.produtos.length };
      console.log(`  -> ${snap.produtos.length} produto(s) capturado(s).`);
    } catch (e) {
      console.log(`  -> falhou (${cfg.labelBadge}): ${e.message}`);
      resultados[cfg.chave] = { erro: e.message };
    } finally {
      await _voltarParaPainel(page);
    }
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
  const resultado = await capturarMetricas(page);
  if (!resultado.ok) throw new Error(resultado.erro);

  const produtosAtivos = await capturarProdutosAtivos(page);

  // Listas de qualidade cadastral (2026-08-07) — pedido do usuário. Roda
  // DEPOIS de capturar métricas/produtos ativos porque clicar nos badges
  // troca o conteúdo do painel; se desse erro aqui os dados já capturados
  // acima não se perdem.
  const listasQualidade = await capturarTodasListasQualidade(page);

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
  capturarTodasListasQualidade,
  rodar,
};
