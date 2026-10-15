#!/usr/bin/env node
/**
 * scripts/x2-comparar-zip.js  (SOMENTE LEITURA — não altera nada)
 *
 * Mostra quais produtos têm foto num backup de zip mas NÃO têm no zip atual.
 * Uso: node scripts/x2-comparar-zip.js <secao> [<sufixo-do-backup>]
 *   ex: node scripts/x2-comparar-zip.js mecanica 1788363933813
 * Sem o 2º argumento, usa o backup MAIOR da seção.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { listarEntradas } = require('../src/utils/zip-reader');
const FOTOS = path.join(__dirname, '..', 'src', 'config', 'catalogo-x2', 'fotos');
const [secao, sufixo] = process.argv.slice(2);
if (!secao) { console.log('Uso: node scripts/x2-comparar-zip.js <secao> [sufixo-do-backup]'); process.exit(1); }

const vivo = path.join(FOTOS, `${secao}.zip`);
let bak;
if (sufixo) bak = path.join(FOTOS, `${secao}.zip.bak-${sufixo}`);
else {
  const c = fs.readdirSync(FOTOS).filter((n) => n.startsWith(`${secao}.zip.bak-`)).map((n) => ({ n, s: fs.statSync(path.join(FOTOS, n)).size })).sort((a, b) => b.s - a.s);
  if (!c.length) { console.log('sem backups'); process.exit(0); }
  bak = path.join(FOTOS, c[0].n);
}
const codigos = (z) => { const m = new Map(); for (const e of listarEntradas(z)) { const i = e.name.indexOf('/'); if (i > 0) { const c = e.name.slice(0, i); m.set(c, (m.get(c) || 0) + 1); } } return m; };
const a = codigos(vivo), b = codigos(bak);
const soNoBackup = [...b.keys()].filter((c) => !a.has(c));
const menosFotos = [...b.keys()].filter((c) => a.has(c) && a.get(c) < b.get(c));
console.log(`Zip atual: ${a.size} produtos | Backup ${path.basename(bak)}: ${b.size} produtos`);
console.log(`Só no backup (sumiram do atual): ${soNoBackup.length}`);
console.log(`Com menos fotos no atual que no backup: ${menosFotos.length}`);
console.log('Exemplos:', soNoBackup.slice(0, 20).join(', ') || '(nenhum)');
