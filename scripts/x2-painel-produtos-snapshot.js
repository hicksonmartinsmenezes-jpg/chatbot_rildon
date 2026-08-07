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

  const snapshot = {
    capturadoEm: new Date().toISOString(),
    metricas: resultado.metricas,
    produtosAtivos,
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
  carregarHistorico,
  salvarSnapshot,
  rodar,
};
