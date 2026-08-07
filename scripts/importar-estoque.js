#!/usr/bin/env node
/**
 * scripts/importar-estoque.js
 *
 * ⚠️ Rodar SEMPRE via:
 *   docker exec chatbot_rildon_app npm run importar-estoque -- <caminho-do-csv>
 * NUNCA direto no host Windows — cairia no Postgres nativo errado (ver
 * memória do projeto "Postgres duplicado na porta 5432" e o aviso no topo
 * de src/services/estoque.service.js).
 *
 * Lê o CSV do Relatório de Estoque (exportado por x2-estoque-export.js) e
 * faz upsert em `estoque_produtos`. Chamado automaticamente por
 * x2-estoque-export.js depois de cada download (via `docker exec`), ou à
 * mão se precisar reimportar um CSV específico.
 *
 * Uso:
 *   node scripts/importar-estoque.js src/data/estoque-latest.csv
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const pool = require('../src/database/postgres');
const { importarCsv } = require('../src/services/estoque.service');

async function main() {
  const caminho = process.argv[2];
  if (!caminho) {
    console.log('Uso: node scripts/importar-estoque.js <caminho-do-csv>');
    process.exit(1);
  }
  const resultado = await importarCsv(path.resolve(caminho));
  console.log(`OK: ${resultado.total} produtos importados de ${resultado.arquivo}.`);
}

main()
  .catch((err) => {
    console.error('Erro fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
