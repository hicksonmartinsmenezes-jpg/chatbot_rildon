#!/usr/bin/env node
/**
 * Limpa entradas "órfãs" dos checkpoints de progresso de fotos (WORK_DIR,
 * fora do projeto) — códigos que ficaram gravados no checkpoint de uma
 * seção mas que não pertencem mais à lista atual de produtos daquela
 * seção.
 *
 * Achado em 2026-08-13 testando ao vivo o Painel X2: ALTERNADOR mostrava
 * "2543/2129" baixados — mais baixados que produtos existem na seção.
 * Causa provável: bug de contaminação entre seções corrigido em
 * 2026-08-12 (commit eab6a30, buscarSecao lia resultado da seção
 * anterior por uma race condition) — durante essas execuções bugadas,
 * códigos de OUTRAS seções ficaram gravados no checkpoint de progresso
 * do ALTERNADOR. O catálogo (lista de produtos) já foi corrigido, mas os
 * checkpoints de progresso nunca foram limpos dessas sobras.
 *
 * Isso é só cosmético — "Publicados" (o que o cliente vê no WhatsApp) é
 * contado à parte e não é afetado. Essa limpeza só deixa "Baixados" <=
 * "Produtos" fazendo sentido de novo no painel.
 *
 * Uso:
 *   node scripts/x2-limpar-checkpoint-orfaos.js            (dry-run, só mostra o que faria)
 *   node scripts/x2-limpar-checkpoint-orfaos.js --aplicar   (aplica de verdade, com backup)
 */

const fs = require('fs');
const path = require('path');
const scraper = require('./x2-fotos-scraper.js');

const { SECOES, CATALOGO_DIR, carregarProgresso, salvarProgresso, progressPath } = scraper;

const aplicar = process.argv.includes('--aplicar');

console.log(aplicar ? 'Modo: APLICANDO limpeza de verdade.\n' : 'Modo: dry-run (nada será alterado — rode com --aplicar pra aplicar).\n');

let totalOrfaosGeral = 0;
let secoesAfetadas = 0;

for (const slug of Object.keys(SECOES)) {
  const jsonPath = path.join(CATALOGO_DIR, `${slug}.json`);
  let produtos;
  try {
    produtos = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch {
    continue; // seção sem catálogo carregado ainda — não mexe
  }
  const codigosAtuais = new Set(produtos.map((p) => String(p.codigo).trim()));

  const progresso = carregarProgresso(slug);
  const chaves = Object.keys(progresso);
  if (chaves.length === 0) continue;

  const orfaos = chaves.filter((c) => !codigosAtuais.has(String(c).trim()));
  if (orfaos.length === 0) continue;

  secoesAfetadas++;
  totalOrfaosGeral += orfaos.length;

  console.log(`${SECOES[slug]} (${slug}): ${chaves.length} no checkpoint, ${produtos.length} produtos atuais, ${orfaos.length} órfão(s) ${aplicar ? 'removendo...' : 'seriam removidos'}`);

  if (aplicar) {
    const backupPath = progressPath(slug) + `.bak-${Date.now()}`;
    fs.copyFileSync(progressPath(slug), backupPath);

    const progressoLimpo = { ...progresso };
    for (const c of orfaos) delete progressoLimpo[c];
    salvarProgresso(slug, progressoLimpo);
  }
}

console.log(`\n${secoesAfetadas} seção(ões) com órfãos, ${totalOrfaosGeral} entrada(s) órfã(s) no total.`);
if (!aplicar && totalOrfaosGeral > 0) {
  console.log('Rode de novo com --aplicar pra aplicar de verdade (faz backup .bak-<timestamp> de cada checkpoint mexido).');
}
if (totalOrfaosGeral === 0) {
  console.log('Nada pra limpar — checkpoints já batem com os catálogos atuais.');
}
