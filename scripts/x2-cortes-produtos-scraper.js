#!/usr/bin/env node
/**
 * scripts/x2-cortes-produtos-scraper.js
 *
 * PEDIDO DO USUÁRIO (2026-08-10): depois de escopar "alerta de estoque
 * baixo, ou coisa assim", explorando o X2 ao vivo achamos o **Painel Cortes
 * de Produtos** (☰ > Vendas 3.0 > Produção de Vendas > aba "Painel Cortes
 * de Produtos") — mostra pedidos que perderam item por FALTA DE ESTOQUE no
 * momento da venda, com R$ de faturamento já perdido de verdade (não é
 * estimativa de "abaixo do mínimo"). Isso é o sinal escolhido pro alerta de
 * estoque baixo. Cadência combinada: DIÁRIO (é perda do dia — quanto antes
 * repõe, menos perde amanhã).
 *
 * ─── Navegação (confirmada ao vivo 2026-08-10, sessão de exploração) ──────
 * ☰ (hamburger) > tile "Vendas 3.0" > "Produção de Vendas" (único item do
 * submenu) > barra de abas no topo do painel > "Painel Cortes de Produtos".
 * Mesma técnica de `clicarTextoExato` (todos os frames, elemento mais
 * específico) já validada em x2-painel-produtos-snapshot.js — usada aqui
 * também, porque essa tela tem a MESMA armadilha (mais de um elemento com
 * texto parecido em frames/menu diferentes).
 *
 * ─── O que a tela mostra e como é extraído ─────────────────────────────
 * 3 cards-resumo (Total de Produtos Cortados / Quantidade de Produtos
 * Cortados / Perda de Faturamento) — confirmado ao vivo: são `<strong>`
 * (elemento-folha) com o número, e o rótulo é o texto do `<div>` pai menos
 * o número. Mesma técnica genérica de `capturarMetricas` no snapshot de
 * Painel de Produtos.
 *
 * O gráfico "Cortes por Produto" é Chart.js — confirmado ao vivo via
 * `window.frames[1].barChart_barras01.config.data` (labels = descrição do
 * produto, datasets[0].data = R$ perdido por produto). NÃO existe tabela
 * HTML por trás do gráfico (confirmado: `document.querySelectorAll('table')`
 * vazio nessa tela) — por isso a extração lê o objeto Chart.js diretamente
 * em vez de tentar ler o SVG/canvas.
 *
 * ⚠️ ESCOPO DELIBERADO: a tela também tem "Cortes por Rota"
 * (`barChart_barras02`), "Cortes por Cliente" (`barChart_barras03`, nomes
 * de CLIENTE) e "Cortes por Vendedor" (`barChart_barras05`, nome de
 * FUNCIONÁRIO). Só `barChart_barras01` (por PRODUTO) é capturado — o
 * usuário pediu explicitamente pra não entrar em dado de cliente durante a
 * exploração ("partes mais sensiveis não chat"), e o alerta em si só
 * precisa saber QUAL PRODUTO faltou, não pra quem.
 *
 * ─── O que NÃO foi confirmado ao vivo (via Playwright) ────────────────────
 * A extração acima foi confirmada via JS executado no Chrome REAL do
 * usuário (Claude in Chrome), não pelo Playwright automatizado — mesma
 * ressalva de todo script novo deste projeto (ver x2-estoque-export.js):
 * precisa de 1ª rodada supervisionada clicando "Rodar agora" no painel.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-cortes-produtos-scraper.js
 *
 * Cada execução SOBRESCREVE `~/.x2-rildon-scraper/cortes-produtos/
 * ultima-captura.json` (retrato do período consultado — por padrão os
 * últimos 2 dias, igual ao filtro padrão da própria tela do X2) e ACRESCENTA
 * uma entrada em `historico.json`. No fim, dispara o alerta de WhatsApp
 * (`x2-whatsapp-alerta.js`) com um resumo — a menos que `semAlerta: true`
 * seja passado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  WORK_DIR: RAIZ_WORK_DIR,
  HOME_URL,
  LOGIN_URL,
  abrirNavegador,
  tentarLoginAutomaticoSeNecessario,
  clicarTextoExato,
  avaliarEmQualquerFrame,
  comRetry,
  salvarDiagnostico,
} = require('./x2-nav-helpers');
const { enviarAlertaWhatsApp } = require('./x2-whatsapp-alerta');

const CORTES_DIR = path.join(RAIZ_WORK_DIR, 'cortes-produtos');
const HISTORICO_PATH = path.join(CORTES_DIR, 'historico.json');
const ULTIMA_CAPTURA_PATH = path.join(CORTES_DIR, 'ultima-captura.json');

function garantirPastas() {
  fs.mkdirSync(CORTES_DIR, { recursive: true });
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

/** Navega até "Vendas 3.0 > Produção de Vendas > Painel Cortes de
 * Produtos". Mesmo formato de `abrirPainelProdutos` em
 * x2-painel-produtos-snapshot.js: em modo automático entra pela LOGIN_URL
 * (goto direto na HOME_URL é bloqueado pelo servidor mesmo já logado — ver
 * x2-estoque-export.js pro relato completo dessa descoberta). */
async function abrirPainelCortes(page, { modoAutomatico } = {}) {
  if (modoAutomatico) {
    await page.goto(LOGIN_URL).catch(() => {});
    await page.waitForTimeout(1000);
    await tentarLoginAutomaticoSeNecessario(page);
    await page.waitForTimeout(1000);
  }

  await page.locator('a').first().click({ timeout: 10000 }); // ☰
  await page.waitForTimeout(500);

  const clicouVendas = await comRetry(
    () => clicarTextoExato(page, 'Vendas 3.0'),
    (frame) => !!frame,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicouVendas) {
    await salvarDiagnostico(page, CORTES_DIR, 'sem-tile-vendas3');
    throw new Error('Não encontrei o tile "Vendas 3.0" no menu ☰. Diagnóstico salvo em debug-sem-tile-vendas3.png/.json.');
  }
  await page.waitForTimeout(800);

  const clicouProducao = await comRetry(
    () => clicarTextoExato(page, 'Produção de Vendas'),
    (frame) => !!frame,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicouProducao) {
    await salvarDiagnostico(page, CORTES_DIR, 'sem-producao-de-vendas');
    throw new Error('Cliquei em "Vendas 3.0" mas não achei "Produção de Vendas" no submenu. Diagnóstico salvo em debug-sem-producao-de-vendas.png/.json.');
  }
  await page.waitForTimeout(1500);

  const clicouCortes = await comRetry(
    () => clicarTextoExato(page, 'Painel Cortes de Produtos'),
    (frame) => !!frame,
    { tentativas: 6, esperaMs: 1000 }
  );
  if (!clicouCortes) {
    await salvarDiagnostico(page, CORTES_DIR, 'sem-aba-cortes');
    throw new Error('Cliquei em "Produção de Vendas" mas não achei a aba "Painel Cortes de Produtos". Diagnóstico salvo em debug-sem-aba-cortes.png/.json.');
  }
  await page.waitForTimeout(1500);
}

/** Extrai os 3 cards-resumo — elementos-folha cujo texto é só dígitos/vírgula
 * (mesma técnica de `capturarMetricas` no snapshot de Painel de Produtos),
 * restrito a `<strong>` (confirmado ao vivo ser a tag usada nessa tela). */
async function capturarResumo(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const resumo = {};
    Array.from(document.querySelectorAll('strong')).forEach((el) => {
      if (el.children.length > 0) return;
      const texto = (el.textContent || '').trim();
      if (!/^\d[\d.,]*$/.test(texto)) return;
      const pai = el.closest('div');
      if (!pai) return;
      const rotulo = (pai.textContent || '').replace(texto, '').trim();
      if (rotulo && rotulo.length > 1 && rotulo.length < 60) {
        resumo[rotulo] = Number(texto.replace(/\./g, '').replace(',', '.'));
      }
    });
    return Object.keys(resumo).length ? resumo : null;
  });
  return resultado || null;
}

/** Lê o gráfico Chart.js "Cortes por Produto" direto do objeto JS (não tem
 * tabela HTML por trás — confirmado ao vivo). ESCOPO: só este gráfico (ver
 * aviso no cabeçalho do arquivo sobre por que os outros 3 gráficos —
 * Rota/Cliente/Vendedor — são ignorados de propósito). */
async function capturarCortesPorProduto(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    // Acha a 1ª variável global cujo nome bate "barChart_barras" em
    // QUALQUER frame — não fixa índice (01/02/...) porque a ordem pode
    // variar; em vez disso, pega o que tem MAIS labels (o de "por produto"
    // tende a ter mais categorias que "por rota"/"por vendedor" — mas o
    // critério real de desempate é ter `datasets[0].data` com valores em
    // R$ e não ser o carrinho "por rota" (2 categorias fixas observadas).
    // Critério objetivo confirmado ao vivo: window.frames[1].barChart_barras01.
    const candidatos = Object.keys(window)
      .filter((k) => /^barChart_barras/i.test(k))
      .map((k) => window[k])
      .filter((c) => c && c.config && c.config.data && Array.isArray(c.config.data.labels));
    if (!candidatos.length) return null;
    // "01" é sempre "por Produto" (confirmado ao vivo 2026-08-10) — prioriza
    // a variável cujo nome termina em "01"; se não achar, usa a 1ª candidata.
    const porProduto = Object.keys(window).find((k) => /barras0?1$/i.test(k) && candidatos.includes(window[k]));
    const chart = porProduto ? window[porProduto] : candidatos[0];
    const labels = chart.config.data.labels || [];
    const dados = (chart.config.data.datasets && chart.config.data.datasets[0] && chart.config.data.datasets[0].data) || [];
    return labels.map((descricao, i) => ({ descricao, perdaReais: Number(dados[i]) || 0 }));
  });
  return resultado || [];
}

function salvarCaptura(snapshot) {
  garantirPastas();
  fs.writeFileSync(ULTIMA_CAPTURA_PATH, JSON.stringify(snapshot, null, 2));
  const historico = fs.existsSync(HISTORICO_PATH) ? JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8')) : [];
  historico.push(snapshot);
  fs.writeFileSync(HISTORICO_PATH, JSON.stringify(historico, null, 2));
}

function carregarUltimaCaptura() {
  if (!fs.existsSync(ULTIMA_CAPTURA_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(ULTIMA_CAPTURA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function carregarHistorico() {
  if (!fs.existsSync(HISTORICO_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(HISTORICO_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/** Monta o texto do alerta de WhatsApp a partir de um snapshot. Função pura
 * (sem I/O) — testável sem navegador nem rede. */
function montarMensagemAlerta(snapshot) {
  const { resumo, produtos } = snapshot;
  const totalProdutos = resumo?.['Total de Produtos Cortados'] ?? produtos.length;
  const qtdCortada = resumo?.['Quantidade de Produtos Cortados'];
  const perdaTotal = resumo?.['Perda de Faturamento'];

  if (!totalProdutos) {
    return '📦 *Cortes de Produtos (X2)* — nenhum corte por falta de estoque no período. 👍';
  }

  const linhas = produtos
    .slice(0, 10)
    .map((p) => `• ${p.descricao} — R$ ${p.perdaReais.toFixed(2).replace('.', ',')}`)
    .join('\n');

  const rodape = produtos.length > 10 ? `\n… e mais ${produtos.length - 10} produto(s).` : '';

  return (
    `📦 *Cortes de Produtos (X2) — perda por falta de estoque*\n\n` +
    `${totalProdutos} produto(s), ${qtdCortada ?? '?'} unidade(s), R$ ${Number(perdaTotal ?? 0).toFixed(2).replace('.', ',')} perdidos no período.\n\n` +
    `${linhas}${rodape}`
  );
}

async function capturarCortesDeProdutos(context, { modoAutomatico } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await abrirPainelCortes(page, { modoAutomatico });

  const resumo = await comRetry(
    () => capturarResumo(page),
    (r) => !!r,
    { tentativas: 6, esperaMs: 1200 }
  );
  if (!resumo) {
    await salvarDiagnostico(page, CORTES_DIR, 'sem-resumo');
    throw new Error('Não achei os cards-resumo (Total de Produtos Cortados / Quantidade / Perda de Faturamento). Diagnóstico salvo em debug-sem-resumo.png/.json.');
  }

  const produtos = await comRetry(
    () => capturarCortesPorProduto(page),
    (r) => Array.isArray(r),
    { tentativas: 6, esperaMs: 1200 }
  );

  return {
    capturadoEm: new Date().toISOString(),
    resumo,
    produtos,
  };
}

async function rodar({ channel, confirmar, modoAutomatico, semAlerta, numeroAlerta } = {}) {
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

    const snapshot = await capturarCortesDeProdutos(context, { modoAutomatico });
    salvarCaptura(snapshot);
    console.log(`Captura salva: ${snapshot.produtos.length} produto(s) cortado(s), R$ ${(snapshot.resumo['Perda de Faturamento'] || 0).toFixed(2)} perdidos.`);

    if (!semAlerta) {
      const mensagem = montarMensagemAlerta(snapshot);
      try {
        await enviarAlertaWhatsApp(mensagem, { numero: numeroAlerta });
        console.log('Alerta de WhatsApp enviado.');
      } catch (e) {
        console.log(`⚠️ Captura OK, mas falhou ao enviar o alerta de WhatsApp: ${e.message}`);
      }
    }

    return snapshot;
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
  CORTES_DIR,
  HISTORICO_PATH,
  ULTIMA_CAPTURA_PATH,
  abrirPainelCortes,
  capturarResumo,
  capturarCortesPorProduto,
  capturarCortesDeProdutos,
  montarMensagemAlerta,
  salvarCaptura,
  carregarUltimaCaptura,
  carregarHistorico,
  rodar,
};
