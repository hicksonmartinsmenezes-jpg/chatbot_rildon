#!/usr/bin/env node
/**
 * scripts/x2-semear-progresso.js
 *
 * Recria o "checkpoint" de fotos (~/.x2-rildon-scraper/progress/<secao>.json)
 * a partir dos zips JÁ PUBLICADOS em src/config/catalogo-x2/fotos/. Serve
 * quando o painel X2 mostra "16.957 fotos pendentes" mas o catálogo já tem
 * as fotos (ex.: depois de migrar de PC sem copiar a pasta .x2-rildon-scraper).
 *
 * Regras (só mexe em checkpoint, nunca em zip/JSON de produtos):
 *  - código que TEM foto no zip da seção vira status "ok";
 *  - código sem foto no zip continua pendente (será baixado de verdade);
 *  - seção que JÁ tem checkpoint é pulada (use --forcar para recriar);
 *  - --dry-run só mostra os números.
 *
 * Uso:  node scripts/x2-semear-progresso.js [--dry-run] [--forcar] [--secao=slug]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { listarEntradas } = require('../src/utils/zip-reader');
const { SECOES, CATALOGO_DIR, progressPath, carregarProgresso, salvarProgresso } = require('./x2-fotos-scraper');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const forcar = args.includes('--forcar');
const so = (args.find((a) => a.startsWith('--secao=')) || '').split('=')[1];
const FOTOS_DIR = path.join(CATALOGO_DIR, 'fotos');

let totalOk = 0, totalPend = 0;
for (const slug of Object.keys(SECOES)) {
  if (so && so !== slug) continue;
  const jsonPath = path.join(CATALOGO_DIR, `${slug}.json`);
  const zipPath = path.join(FOTOS_DIR, `${slug}.zip`);
  if (!fs.existsSync(jsonPath) || !fs.existsSync(zipPath)) { console.log(`${slug}: sem json ou zip — pulei`); continue; }
  if (fs.existsSync(progressPath(slug)) && !forcar) {
    console.log(`${slug}: já tem checkpoint (${Object.keys(carregarProgresso(slug)).length}) — pulei (use --forcar)`);
    continue;
  }
  let entradas;
  try { entradas = listarEntradas(zipPath); } catch (e) { console.log(`${slug}: zip ilegível (${e.message}) — pulei`); continue; }
  const porCodigo = new Map();
  for (const e of entradas) {
    const i = e.name.indexOf('/');
    if (i <= 0) continue;
    const c = e.name.slice(0, i);
    if (!porCodigo.has(c)) porCodigo.set(c, []);
    porCodigo.get(c).push(e.name.slice(i + 1));
  }
  const ts = fs.statSync(zipPath).mtime.toISOString();
  const produtos = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const progresso = {};
  let ok = 0;
  for (const p of produtos) {
    const arq = porCodigo.get(String(p.codigo));
    if (arq && arq.length) { progresso[p.codigo] = { status: 'ok', arquivos: arq, detalhes: [], ts, origem: 'zip-existente' }; ok++; }
  }
  const pend = produtos.length - ok;
  totalOk += ok; totalPend += pend;
  console.log(`${slug}: ${ok} com foto no zip → "ok"; ${pend} continuam pendentes${dry ? ' (dry-run)' : ''}`);
  if (!dry) salvarProgresso(slug, progresso);
}
console.log(`\nTotal: ${totalOk} marcados ok, ${totalPend} pendentes reais.${dry ? ' (nada foi gravado)' : ''}`);
