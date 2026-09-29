#!/usr/bin/env node
/**
 * scripts/organizar-aplicacoes-ia.js (Issue #23, pedido do usuário 2026-08-26)
 *
 * Pré-processa (com IA, ver ai.service.js#organizarAplicacaoIA) o texto de
 * "aplicação" (veículo/máquina compatível) dos produtos de UM fabricante —
 * ou de TODOS — e grava o resultado no cache em disco
 * (src/config/catalogo-x2/aplicacao-ia-cache.json, ver
 * catalogo-aplicacao-ia.service.js).
 *
 * Rodar isso ANTES de imprimir o Catálogo Completo de um fabricante deixa a
 * exportação em PDF rápida (0 chamada de IA na hora do clique — só lê o
 * cache já pronto). Sem rodar isso antes, o controller ainda tenta um
 * "melhor esforço" limitado (poucos itens novos) na hora de gerar o PDF —
 * mas fabricante grande (centenas de textos únicos) só fica 100% coberto
 * rodando este script, sem pressa, sem cap.
 *
 * ⚠️ Não depende de Postgres nem do container Docker rodando — só lê os
 * JSONs de ficha em src/config/catalogo-x2/ e chama a API de IA configurada
 * no .env (AI_PROVIDER). Pode rodar direto no host, mas cuidado com o rate
 * limit do provedor: o padrão (Groq free tier) intercala 1 chamada a cada
 * ~20s — um fabricante com 200 textos únicos pode levar mais de 1h.
 *
 * Uso:
 *   node scripts/organizar-aplicacoes-ia.js --fabricante=RAINHA
 *   node scripts/organizar-aplicacoes-ia.js --todos
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { buscarProdutosPainel, listarFabricantes } = require('../src/services/catalogo-x2.service');
const { anexarAplicacoesOrganizadas } = require('../src/services/catalogo-aplicacao-ia.service');

function parseArgs() {
  const args = process.argv.slice(2);
  const fabricanteArg = args.find(a => a.startsWith('--fabricante='));
  const todos = args.includes('--todos');
  return {
    fabricante: fabricanteArg ? fabricanteArg.split('=')[1] : null,
    todos,
  };
}

async function processarFabricante(fabricante) {
  const { produtos } = buscarProdutosPainel({ fabricante, limite: Infinity });
  const comAplicacao = produtos.filter(p => p.aplicacao);
  console.log(`\n── ${fabricante} — ${produtos.length} produto(s), ${comAplicacao.length} com texto de aplicação`);
  if (!comAplicacao.length) {
    console.log('   nada pra organizar.');
    return;
  }
  const resultado = await anexarAplicacoesOrganizadas(comAplicacao, { maxNovos: Infinity });
  console.log(
    `   ${resultado.totalUnicos} texto(s) único(s) — ${resultado.jaEmCache} já em cache, ` +
    `${resultado.novosComSucesso}/${resultado.novosProcessados} novo(s) organizado(s) agora.`
  );
}

async function main() {
  const { fabricante, todos } = parseArgs();

  if (!fabricante && !todos) {
    console.log('Uso: node scripts/organizar-aplicacoes-ia.js --fabricante=NOME');
    console.log('  ou node scripts/organizar-aplicacoes-ia.js --todos');
    process.exit(1);
  }

  if (todos) {
    const fabricantes = listarFabricantes();
    console.log(`Processando ${fabricantes.length} fabricante(s) — isso pode demorar bastante dependendo do provedor de IA configurado.`);
    for (const f of fabricantes) {
      await processarFabricante(f);
    }
  } else {
    await processarFabricante(fabricante);
  }

  console.log('\nConcluído.');
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exitCode = 1;
});
