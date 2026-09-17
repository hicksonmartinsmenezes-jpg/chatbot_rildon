#!/usr/bin/env node
/**
 * scripts/build-frontend.js
 *
 * Empacota os arquivos JS/CSS do painel (frontend/) em um bundle único
 * minificado cada, com hash de conteúdo no nome — sem reescrever o
 * código (continua tudo em escopo global via window, sem import/export).
 *
 * Resolve dois problemas concretos do painel atual: ~25 requisições HTTP
 * separadas a cada carregamento, e o cache-busting manual via "?v=NN"
 * que precisa ser incrementado à mão a cada alteração.
 *
 * Uso: node scripts/build-frontend.js
 * (chamado por `npm run build:frontend`, e pelo estágio builder do Dockerfile)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const DIST_DIR = path.join(FRONTEND_DIR, 'dist');
const INDEX_HTML = path.join(FRONTEND_DIR, 'index.html');

// Ordem EXATA dos <script> hoje em index.html (entre os marcadores
// JS_BUNDLE_START/END). Precisa bater com a ordem real: os arquivos
// dependem de globals definidos pelos anteriores (sem import/export).
const JS_FILES = [
  'js/00-core.js',
  'js/01-utils.js',
  'js/02-auth.js',
  'js/03-navigation.js',
  'js/history/history-utils.js',
  'js/04-history.js',
  'js/05-metrics.js',
  'js/tickets/tickets-render.js',
  'js/06-tickets.js',
  'js/conversations/conversations-utils.js',
  'js/conversations/conversations-render.js',
  'js/07-conversations.js',
  'js/conversations/conversations-media-reply.js',
  'js/08-settings.js',
  'js/09-users.js',
  'js/11-profile.js',
  'js/12-socket.js',
  'js/12-wa-recovery.js',
  'js/campaigns/campaigns-render.js',
  'js/campaigns/campaigns-modal.js',
  'js/13-campaigns.js',
  'js/14-charts.js',
  'js/15-modal.js',
  'js/contacts/contacts-utils.js',
  'js/16-contacts.js',
  'js/18-catalogo.js',
  'js/13-main.js',
  'js/17-ui-events.js',
];

// Ordem EXATA da cadeia de @import em style.css, com supervisor.css por
// último (carregado depois de style.css no index.html original).
const CSS_FILES = [
  'css/01-base.css',
  'css/02-layout.css',
  'css/03-components.css',
  'css/04-login.css',
  'css/05-tickets.css',
  'css/06-conversations.css',
  'css/07-settings.css',
  'css/08-profile.css',
  'css/09-dashboard.css',
  'css/10-history.css',
  'css/11-campaigns.css',
  'css/12-ux-global.css',
  'css/14-contacts.css',
  'css/16-metrics.css',
  'css/17-catalogo.css',
  'css/19-motion.css',
  'css/09-wa-recovery.css',
  'css/15-light-theme.css', // tema claro deve ser o último (sobrescreve os demais)
  'supervisor.css',
];

function readAll(files, separator) {
  return files
    .map(rel => {
      const full = path.join(FRONTEND_DIR, rel);
      if (!fs.existsSync(full)) {
        throw new Error(`Arquivo esperado não encontrado: ${rel}`);
      }
      return fs.readFileSync(full, 'utf8');
    })
    .join(separator);
}

function contentHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

function cleanOldBundles(ext) {
  if (!fs.existsSync(DIST_DIR)) return;
  for (const f of fs.readdirSync(DIST_DIR)) {
    if (f.startsWith('bundle.') && f.endsWith(ext)) {
      fs.unlinkSync(path.join(DIST_DIR, f));
    }
  }
}

function replaceBetweenMarkers(html, startMarker, endMarker, replacement) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Marcadores "${startMarker}" / "${endMarker}" não encontrados em index.html. ` +
        'Restaure os comentários manualmente antes de rodar o build.'
    );
  }
  const before = html.slice(0, start + startMarker.length);
  const after = html.slice(end);
  return `${before}\n  ${replacement}\n  ${after}`;
}

// Budget com folga real sobre o tamanho atual (218.4 KB JS / 259.4 KB CSS
// em 2026-08-17, minificado) — não é um teto "justo", é uma rede de
// segurança contra crescimento descontrolado (ex: lib pesada importada por
// engano). Se o build passar disso de propósito (nova feature grande),
// suba o número aqui mesmo, no mesmo PR que justifica o aumento.
const BUDGET_KB = { js: 400, css: 350 };

async function build() {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // ── JS ──────────────────────────────────────────────────────────────
  // Separador "\n;\n" evita problemas de ASI ao concatenar scripts que
  // não terminam em ";" com scripts que começam com "(" ou "[".
  const jsSource = readAll(JS_FILES, '\n;\n');
  const jsResult = await esbuild.transform(jsSource, {
    loader: 'js',
    minify: true,
    target: 'es2018',
  });
  const jsHash = contentHash(jsResult.code);
  cleanOldBundles('.js');
  fs.writeFileSync(path.join(DIST_DIR, `bundle.${jsHash}.js`), jsResult.code);

  // ── CSS ─────────────────────────────────────────────────────────────
  const cssSource = readAll(CSS_FILES, '\n');
  const cssResult = await esbuild.transform(cssSource, {
    loader: 'css',
    minify: true,
  });
  const cssHash = contentHash(cssResult.code);
  cleanOldBundles('.css');
  fs.writeFileSync(path.join(DIST_DIR, `bundle.${cssHash}.css`), cssResult.code);

  // ── index.html ──────────────────────────────────────────────────────
  let html = fs.readFileSync(INDEX_HTML, 'utf8');

  html = replaceBetweenMarkers(
    html,
    '<!-- JS_BUNDLE_START (gerado por scripts/build-frontend.js — não editar à mão) -->',
    '<!-- JS_BUNDLE_END -->',
    `<script src="dist/bundle.${jsHash}.js"></script>`
  );

  html = replaceBetweenMarkers(
    html,
    '<!-- CSS_BUNDLE_START (gerado por scripts/build-frontend.js — não editar à mão) -->',
    '<!-- CSS_BUNDLE_END -->',
    `<link rel="stylesheet" href="dist/bundle.${cssHash}.css">`
  );

  fs.writeFileSync(INDEX_HTML, html);

  const jsSizeKb = Buffer.byteLength(jsResult.code) / 1024;
  const cssSizeKb = Buffer.byteLength(cssResult.code) / 1024;
  console.log(`OK bundle JS:  dist/bundle.${jsHash}.js  (${jsSizeKb.toFixed(1)} KB, ${JS_FILES.length} arquivos)`);
  console.log(`OK bundle CSS: dist/bundle.${cssHash}.css (${cssSizeKb.toFixed(1)} KB, ${CSS_FILES.length} arquivos)`);
  console.log('OK index.html atualizado.');

  const overBudget = [];
  if (jsSizeKb > BUDGET_KB.js) overBudget.push(`JS: ${jsSizeKb.toFixed(1)} KB > orçamento de ${BUDGET_KB.js} KB`);
  if (cssSizeKb > BUDGET_KB.css) overBudget.push(`CSS: ${cssSizeKb.toFixed(1)} KB > orçamento de ${BUDGET_KB.css} KB`);
  if (overBudget.length > 0) {
    throw new Error(`Orçamento de tamanho do bundle estourado — ${overBudget.join('; ')}`);
  }
}

build().catch(err => {
  console.error('Falha no build do frontend:', err.message);
  process.exit(1);
});
