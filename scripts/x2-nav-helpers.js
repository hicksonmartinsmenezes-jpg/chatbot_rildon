#!/usr/bin/env node
/**
 * scripts/x2-nav-helpers.js
 *
 * PEDIDO DO USUÁRIO (2026-08-10): "vamos lá então" — depois de escopar os
 * alertas de "Cortes de Produtos" (estoque baixo com perda de faturamento
 * real) e "Curva ABC produtos parados" (sem venda há N dias), os dois novos
 * scripts (`x2-cortes-produtos-scraper.js` e `x2-curva-abc-parados-scraper.js`)
 * precisam do MESMO conjunto de primitivas de navegação robusta já validadas
 * em `x2-painel-produtos-snapshot.js` (abrir navegador com perfil salvo,
 * login automático em modo rotina, clicar por texto em qualquer frame,
 * avaliar JS em qualquer frame, retry com espera).
 *
 * Em vez de duplicar ~150 linhas de novo (ou pior, importar funções privadas
 * não-exportadas de outro script), essas primitivas foram extraídas pra cá —
 * CÓPIA fiel do que já roda em produção em `x2-painel-produtos-snapshot.js`
 * (mesmo texto, mesmos comentários de contexto), não uma reescrita. O
 * arquivo original NÃO foi tocado (zero risco de regressão no que já
 * funciona) — ele continua com sua própria cópia local dessas funções.
 * Scripts NOVOS (cortes de produtos, curva ABC parados) importam daqui.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium } = require('playwright');

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const PROFILE_DIR = path.join(WORK_DIR, 'chrome-profile');

const HOME_URL = 'https://sistemas7.xprocess.com.br/x2rildon/www/index_main4.jsp';
const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';

function garantirPastaPerfil() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

async function abrirNavegador(channel) {
  garantirPastaPerfil();
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
 * PRIMEIRO frame em que `avaliador` devolver algo "truthy". */
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

/** Roda `tentativa` várias vezes com espera fixa entre elas, até ela
 * devolver algo que passe em `estaOk`. */
async function comRetry(tentativa, estaOk, { tentativas = 5, esperaMs = 1000 } = {}) {
  let ultimoResultado;
  for (let i = 0; i < tentativas; i++) {
    ultimoResultado = await tentativa();
    if (estaOk(ultimoResultado)) return ultimoResultado;
    await new Promise((resolve) => setTimeout(resolve, esperaMs));
  }
  return ultimoResultado;
}

/** Salva screenshot + textos-folha de todos os frames pra debug, na pasta
 * indicada — mesmo formato usado em x2-painel-produtos-snapshot.js. */
async function salvarDiagnostico(page, pastaDestino, sufixo) {
  fs.mkdirSync(pastaDestino, { recursive: true });
  await page.screenshot({ path: path.join(pastaDestino, `debug-${sufixo}.png`), fullPage: true }).catch(() => {});
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
    path.join(pastaDestino, `debug-${sufixo}.json`),
    JSON.stringify({ urlPrincipal: page.url(), frames: porFrame }, null, 2)
  );
}

module.exports = {
  WORK_DIR,
  PROFILE_DIR,
  HOME_URL,
  LOGIN_URL,
  abrirNavegador,
  tentarLoginAutomaticoSeNecessario,
  clicarTextoExato,
  avaliarEmQualquerFrame,
  comRetry,
  salvarDiagnostico,
};
