#!/usr/bin/env node
/**
 * scripts/importar-localizacao.js
 *
 * ⚠️ Rodar SEMPRE via:
 *   docker exec chatbot_rildon_app npm run importar-localizacao -- <caminho-do-json>
 * NUNCA direto no host Windows — cairia no Postgres nativo errado (ver
 * memória do projeto "Postgres duplicado na porta 5432" e o aviso no topo
 * de src/services/localizacao.service.js).
 *
 * Lê o JSON de resultados da busca de Endereçamento (gravado por
 * x2-localizacao-scraper.js) e faz upsert em `localizacoes_produtos`.
 * Chamado automaticamente pelo scraper depois de cada rodada (via
 * `docker exec`), ou à mão se precisar reimportar um arquivo específico.
 *
 * Uso:
 *   node scripts/importar-localizacao.js src/data/localizacao-latest.json
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('../src/database/postgres');
const { importarJson } = require('../src/services/localizacao.service');

async function main() {
  const caminho = process.argv[2];
  if (!caminho) {
    console.log('Uso: node scripts/importar-localizacao.js <caminho-do-json>');
    process.exit(1);
  }
  const resultado = await importarJson(path.resolve(caminho));
  console.log(`OK: ${resultado.total} resultado(s) importados de ${resultado.arquivo}.`);
}

main()
  .catch((err) => {
    console.error('Erro fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
