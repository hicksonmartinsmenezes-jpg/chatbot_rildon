#!/usr/bin/env node
/**
 * scripts/x2-fotos-menu.js
 *
 * PEDIDO DO USUÁRIO (2026-07-28): "consegue criar um executável onde eu
 * possa selecionar sessão/linha na área de trabalho, clique e ele já
 * faça isso?" — um jeito de clicar 2x num ícone e escolher visualmente
 * quais Seções processar, em vez de digitar `--secao=` / `--secoes=` na
 * mão toda vez.
 *
 * Não é um .exe de verdade (empacotar isso com Electron seria muito mais
 * pesado pra manter só por causa disso) — é um menu interativo no
 * terminal (setas + espaço pra marcar, Enter pra confirmar), disparado
 * por um atalho `.bat` que dá duplo-clique. Pra você: funciona igual —
 * clica no ícone, escolhe na tela, aperta Enter, e ele já roda sozinho.
 *
 * ─── Como colocar na Área de Trabalho ───────────────────────────────────
 * 1. Vá em `scripts/` dentro da pasta do projeto.
 * 2. Clique com o botão direito em "Atualizar Fotos X2.bat".
 * 3. "Enviar para" > "Área de trabalho (criar atalho)".
 * Pronto — a partir daí é só dar duplo-clique nesse atalho.
 *
 * Reusa toda a lógica de scripts/x2-fotos-scraper.js (esse arquivo só é a
 * "cara" do menu; quem processa de verdade é o outro).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const {
  SECOES,
  CATALOGO_DIR,
  carregarProgresso,
  rodarMuitasSecoes,
  montarZipFinal,
} = require('./x2-fotos-scraper');
const { rodar: rodarSync } = require('./x2-catalogo-sync');

function statusSecao(slug) {
  try {
    const produtos = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8'));
    const total = produtos.length;
    const progresso = carregarProgresso(slug);
    const feitos = Object.keys(progresso).length;
    return { total, feitos, pendentes: total - feitos };
  } catch {
    return { total: 0, feitos: 0, pendentes: 0 };
  }
}

// Pedido do usuário (2026-07-28): nas opções de baixar fotos e procurar
// produtos novos, oferecer um jeito rápido de "processar tudo" em vez de
// precisar marcar seção por seção (ou lembrar do atalho de teclado "a") —
// e uma opção explícita de "Voltar" em vez de só Ctrl+C. Retorna `null`
// tanto pra "Voltar" quanto pra cancelamento (Esc/Ctrl+C) — o chamador
// trata os dois do mesmo jeito: volta pro menu principal.
async function escolherSecoes(choices) {
  const { modo } = await prompts({
    type: 'select',
    name: 'modo',
    message: 'Quais seções?',
    choices: [
      { title: 'Todas as seções', value: 'todas' },
      { title: 'Escolher específicas', value: 'escolher' },
      { title: '« Voltar', value: 'voltar' },
    ],
  });

  if (!modo || modo === 'voltar') return null;
  if (modo === 'todas') return choices.map((c) => c.value);

  const { secoes } = await prompts({
    type: 'multiselect',
    name: 'secoes',
    message: 'Marque as seções (espaço marca, "a" marca todas, Enter confirma)',
    choices,
    hint: '- Espaço pra marcar. Enter pra confirmar.',
    instructions: false,
  });
  return secoes && secoes.length ? secoes : null;
}

function montarChoices() {
  return Object.entries(SECOES).map(([slug, label]) => {
    const { total, feitos, pendentes } = statusSecao(slug);
    let descricao;
    if (total === 0) descricao = '(dados não encontrados)';
    else if (pendentes === 0) descricao = 'já completa nesta ferramenta';
    else if (feitos === 0) descricao = `${total} produtos, nada processado ainda`;
    else descricao = `${feitos}/${total} feitos, faltam ${pendentes}`;
    return { title: `${label}`, description: descricao, value: slug };
  });
}

// Pedido do usuário (2026-07-28): ter uma opção explícita de "Voltar" em vez
// de só sair do script inteiro — por isso o menu principal roda em loop:
// terminar uma ação (ou cancelar/voltar no meio dela) volta pra cá, em vez
// de fechar o programa. Só sai de fato escolhendo "Sair" ou fechando a
// janela.
async function main() {
  console.log('==============================================');
  console.log(' Atualizar Fotos X2 — menu');
  console.log('==============================================\n');

  for (;;) {
    const { acao } = await prompts({
      type: 'select',
      name: 'acao',
      message: 'O que você quer fazer?',
      choices: [
        { title: 'Baixar fotos (escolher seções)', value: 'baixar' },
        { title: 'Procurar produtos novos no X2', value: 'sync' },
        { title: 'Montar .zip final de uma seção já completa', value: 'zip' },
        { title: 'Sair', value: 'sair' },
      ],
    });

    if (!acao || acao === 'sair') { console.log('Até mais!'); return; }

    if (acao === 'sync') {
      const secoes = await escolherSecoes(Object.entries(SECOES).map(([slug, label]) => ({ title: label, value: slug })));
      if (!secoes) continue; // voltou ou cancelou — mostra o menu principal de novo

      const { dryRun } = await prompts({
        type: 'confirm',
        name: 'dryRun',
        message: 'Só mostrar o que encontraria, sem gravar nada ainda (--dry-run)?',
        initial: true,
      });

      // Pedido do usuário (2026-07-28): código que já está no catálogo mas
      // não é mais encontrado no X2 é tratado como produto desativado e
      // REMOVIDO por padrão (com backup automático do JSON antigo).
      const { removerDesativados } = await prompts({
        type: 'confirm',
        name: 'removerDesativados',
        message: 'Remover do catálogo os códigos que não forem mais encontrados no X2 (prováveis desativados)?',
        initial: true,
      });

      await rodarSync(secoes, { channel: 'chrome', dryRun, semRemover: !removerDesativados });
      console.log('\nSe encontrou produto novo e NÃO era --dry-run, rode "Baixar fotos" nessas mesmas seções pra baixar a foto deles.\n');
      continue;
    }

    if (acao === 'zip') {
      const { secao } = await prompts({
        type: 'autocomplete',
        name: 'secao',
        message: 'Qual seção montar o zip?',
        choices: [
          ...montarChoices().map((c) => ({ title: `${c.title} — ${c.description}`, value: c.value })),
          { title: '« Voltar', value: null },
        ],
      });
      if (!secao) continue;
      await montarZipFinal(secao);
      console.log('');
      continue;
    }

    // acao === 'baixar'
    const secoes = await escolherSecoes(montarChoices());
    if (!secoes) continue;

    const { limitTexto } = await prompts({
      type: 'text',
      name: 'limitTexto',
      message: 'Limite de produtos por seção nesta execução (Enter = sem limite, processa tudo que falta)',
    });
    const limit = limitTexto && limitTexto.trim() ? parseInt(limitTexto.trim(), 10) : null;

    const { retrySemFoto } = await prompts({
      type: 'confirm',
      name: 'retrySemFoto',
      message: 'Tentar de novo os produtos já marcados "sem foto"/"placeholder" (caso o X2 tenha cadastrado a foto depois)?',
      initial: false,
    });

    await rodarMuitasSecoes(secoes, { limit, channel: 'chrome', retrySemFoto });
    console.log('\nPronto! Pra montar o .zip final de uma seção completa, escolha essa opção no menu.\n');
  }
}

main().catch((err) => {
  console.error('\nErro:', err.message);
  process.exitCode = 1;
});
