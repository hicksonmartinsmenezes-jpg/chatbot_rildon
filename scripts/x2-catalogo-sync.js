#!/usr/bin/env node
/**
 * scripts/x2-catalogo-sync.js
 *
 * PEDIDO DO USUÁRIO (2026-07-28): "quero fazer uma ferramenta parecida [com o
 * x2-fotos-scraper.js], só que dessa vez fazer o que fizemos antes de ir
 * pegando produtos novos" — o `x2-fotos-scraper.js` só baixa foto de
 * produtos que JÁ estão nos JSONs de `src/config/catalogo-x2/` (extraídos
 * uma vez em 2026-07-20). Se um produto NOVO aparecer no X2, ele nunca fica
 * sabendo. Este script fecha essa lacuna: refaz a extração em massa (a MESMA
 * tela usada na extração original, "Compras > Catálogo de Produtos") seção
 * por seção, e ACRESCENTA ao JSON só os códigos que ainda não existem nele
 * — nunca apaga nem altera um produto já salvo.
 *
 * Depois de rodar isso, o `x2-fotos-scraper.js` já pega os códigos novos
 * sozinho na próxima execução (ele trata qualquer código do JSON sem
 * checkpoint de progresso como pendente) — não precisa fazer mais nada além
 * de rodar os dois scripts em sequência.
 *
 * ─── Decisão consciente: SEM ficha técnica estruturada por enquanto ────────
 * Cada produto tem uma "ficha" (referência, dados técnicos, aplicação,
 * equivalentes, sistema etc.) usada pela busca do catálogo por veículo/
 * código original (ver catalogo-x2.service.js). O texto bruto que gera essa
 * ficha varia bastante de formato entre produtos (numeração diferente,
 * campos que aparecem ou não, nomes de campo com pequenas variações) — o
 * parser original que gerou as fichas de 2026-07-20 nunca foi salvo como
 * código. Reconstruir esse parser é um projeto à parte (reverse-engineering
 * validado contra os ~17 mil produtos já existentes como gabarito) e uma
 * versão malfeita seria PIOR que não ter ficha nenhuma — dado errado no
 * campo aplicação/equivalentes pode fazer a IA "confirmar" aplicação errada
 * pro cliente, silenciosamente. Decisão do usuário (2026-07-28): produtos
 * novos entram com `ficha: null` (o restante do sistema já trata isso como
 * "sem ficha disponível", igual aos 19 produtos antigos que também não têm)
 * até esse parser ser construído e validado à parte.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-catalogo-sync.js --secao=componentes-eletricos
 *   node scripts/x2-catalogo-sync.js --secao=componentes-eletricos --dry-run       (só mostra o que encontraria/removeria, não grava nada)
 *   node scripts/x2-catalogo-sync.js --secao=componentes-eletricos --sem-remover   (só acrescenta novos, nunca remove nada — mais conservador)
 *   node scripts/x2-catalogo-sync.js --secao=componentes-eletricos --forcar-remocao (PEDIDO DO USUÁRIO 2026-08-05: confirma remoção em massa — normalmente
 *                                                                                    travada quando >30% dos produtos "somem" de uma vez, provável falha
 *                                                                                    na busca em vez de descontinuação real)
 *   node scripts/x2-catalogo-sync.js --todas                                      (todas as 26 seções, 1 login só)
 *
 * ─── Produtos desativados (PEDIDO DO USUÁRIO, 2026-07-28) ─────────────────
 * Um código que já está no nosso JSON mas NÃO aparece mais na busca por
 * Seção no X2 é tratado como desativado/descontinuado pela loja — o script
 * REMOVE esse código do JSON automaticamente (comportamento padrão, dá pra
 * desligar com `--sem-remover`). Sempre faz backup do JSON antigo
 * (`<secao>.json.bak-<timestamp>`) antes de sobrescrever, igual já fazemos
 * com os zips de foto — nada é destruído sem cópia de segurança. Antes de
 * decidir "não achei = desativado", o script RESETA explicitamente todos os
 * filtros da tela (Unidade=Todas, Linha/Sub-Linha=Todos, Imagem/Descrição/
 * Estoque/Medidas=Indiferente, etc. — valores confirmados ao vivo em
 * 2026-07-28) pra garantir que "não encontrado" é real e não um resquício
 * de filtro deixado de uma busca manual anterior na mesma aba.
 *
 * ─── Tela usada e por quê ───────────────────────────────────────────────
 * "Compras > Catálogo de Produtos" (não confundir com "Vendas 3.0 >
 * Produção de Vendas > Catálogo de Produtos", usada pelo script de fotos —
 * ver memória "reference-x2-catalogo-produtos-paginas"). Essa tela roda
 * DENTRO da mesma janela principal do X2 (iframe `principal`), não é um
 * popup separado — diferente da tela de fotos. Campos confirmados ao vivo
 * em 2026-07-28: `select[name="id_secao"]` + função global `pesquisar()`
 * (chamada pelo botão "Pesquisar Produto"). Cada produto aparece 3x no
 * resultado (uma por unidade/depósito) — o script deduplica por código.
 * A ficha técnica bruta de cada produto vem de
 * `<textarea name="ds_descricao_detalhada{codigo}">` (todas as 3 cópias
 * têm o mesmo conteúdo, confirmado ao vivo).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { chromium } = require('playwright');
const { SECOES } = require('./x2-fotos-scraper');

const PROJECT_ROOT = path.join(__dirname, '..');
const CATALOGO_DIR = path.join(PROJECT_ROOT, 'src', 'config', 'catalogo-x2');

// Reusa o MESMO perfil de Chrome (e portanto o mesmo login já salvo) do
// script de fotos — não faz sentido logar duas vezes em ferramentas
// irmãs. Fora do OneDrive de propósito (ver x2-fotos-scraper.js).
const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const PROFILE_DIR = path.join(WORK_DIR, 'chrome-profile');

const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resp) => { rl.close(); resolve(resp); }));
}

// ─── Parsing do texto bruto do resultado (validado ao vivo em 2026-07-28
// contra a seção GERADOR — bateu byte a byte com o JSON já salvo) ─────────

const CABECALHO_RESULTADO = 'Produto\tDescrição detalhada\tVolumetria';

function parsearProdutos(textoCompleto) {
  const idx = textoCompleto.indexOf(CABECALHO_RESULTADO);
  if (idx === -1) return [];
  const bloco = textoCompleto.slice(idx + CABECALHO_RESULTADO.length);
  const linhas = bloco.split('\n');

  const produtosMap = new Map();
  let atual = null;

  const salvarAtual = () => {
    if (atual && atual.codigo && !produtosMap.has(atual.codigo)) {
      produtosMap.set(atual.codigo, {
        codigo: atual.codigo,
        nome: atual.nome || '',
        barras: atual.barras || null,
        secao: atual.secao || null,
        linha: atual.linha || null,
      });
    }
  };

  for (const linhaRaw of linhas) {
    const linha = linhaRaw.replace(/\s+$/, '');
    const mCabecalho = linha.match(/^\d+\t\t(\d+)\s*-\s*(.+)$/);
    if (mCabecalho) {
      salvarAtual(); // fecha o produto anterior antes de abrir um novo (mesmo se não achou seção/linha)
      atual = { codigo: mCabecalho[1], nome: mCabecalho[2].trim() };
      continue;
    }
    if (!atual) continue;
    const mBarras = linha.match(/^Código de barras:\s*(\S*)/);
    if (mBarras) { atual.barras = mBarras[1] || null; continue; }
    if (!atual.secao) {
      const mSecaoLinha = linha.match(/^([^\t>]+?)\s*>\s*(.+?)\s*$/);
      if (mSecaoLinha) { atual.secao = mSecaoLinha[1].trim(); atual.linha = mSecaoLinha[2].trim(); }
    }
  }
  salvarAtual(); // último produto do bloco

  return Array.from(produtosMap.values());
}

// ─── Navegador (mesmo padrão do x2-fotos-scraper.js) ─────────────────────

async function abrirNavegador(channel) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, { channel, headless: false, viewport: null });
}

async function telaTemFormulario(page) {
  return page.evaluate(() => {
    const el = document.querySelector('iframe[name="principal"]');
    return !!(el && el.contentDocument && el.contentDocument.querySelector('select[name="id_secao"]'));
  }).catch(() => false);
}

// Diferente do popup de fotos: essa tela roda DENTRO da janela principal do
// X2 (SPA — a URL da aba não muda ao trocar de menu), não é uma janela
// separada. Por isso a detecção é "o formulário certo está visível dentro
// do iframe principal", não "existe uma aba com essa URL".
// Pedido do usuário (2026-08-05): mesmo parâmetro opcional `confirmar` do
// x2-fotos-scraper.js — o painel visual passa uma função que só resolve
// quando o usuário clica "Já cliquei, continuar" na página, em vez de travar
// num readline de terminal. Sem esse parâmetro, comportamento idêntico a
// antes (CLI/menu continuam com o Enter no terminal).
async function garantirTelaCatalogoAberta(context, { confirmar } = {}) {
  for (const page of context.pages()) {
    if (await telaTemFormulario(page)) return page;
  }

  const page = context.pages()[0] || (await context.newPage());
  if (!page.url().includes('xprocess.com.br')) {
    await page.goto(LOGIN_URL).catch(() => {});
  }

  console.log('\n==============================================================');
  console.log('Faça login se precisar (a sessão fica salva).');
  console.log('Depois vá em: Compras > "Catálogo de Produtos"');
  console.log('(botão de primeiro nível, ao lado de "Gestão de Produtos" e "Curva ABC").');
  console.log('==============================================================\n');

  if (confirmar) {
    await confirmar('Abra a tela "Compras > Catálogo de Produtos" no X2 e clique em "Já cliquei, continuar" abaixo.');
  } else {
    await ask('Pressione Enter DEPOIS que a tela "Catálogo de Produtos" (com o campo Seção) estiver visível... ');
  }

  if (!(await telaTemFormulario(page))) {
    throw new Error('Não encontrei a tela "Catálogo de Produtos" (Compras) aberta. Confirme e rode de novo.');
  }
  return page;
}

// Valores confirmados ao vivo em 2026-07-28 (ver cabeçalho do arquivo) —
// deixam a busca sem NENHUM filtro além da Seção, pra "não encontrado"
// significar de verdade "não existe mais", não "excluído por um filtro
// esquecido de uma busca manual anterior".
async function buscarSecao(page, labelSecao) {
  await page.evaluate((labelAlvo) => {
    function norm(s) {
      return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    }
    function marcarRadio(doc, name, valor) {
      const el = doc.querySelector(`input[name="${name}"][value="${valor}"]`);
      if (el) el.checked = true;
    }
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame.contentDocument;
    const win = frame.contentWindow;

    // Limpa todos os campos de texto/data — nenhum filtro além da Seção.
    for (const nome of ['ds_descricao_comercial', 'id_produto', 'cd_barras', 'dt_inicio', 'dt_fim', 'dt_inicio_recebimento', 'dt_fim_recebimento']) {
      const el = doc.querySelector(`input[name="${nome}"]`);
      if (el) el.value = '';
    }
    // "Todos"/"Todas" em todos os selects, exceto Seção (setado abaixo).
    for (const nome of ['id_empresa', 'id_linha', 'id_sub_linha', 'id_fornecedor_pesq', 'id_fabricante_pesq']) {
      const el = doc.querySelector(`select[name="${nome}"]`);
      if (el) el.value = '';
    }
    // "Indiferente"/"Não" em todos os grupos de radio.
    marcarRadio(doc, 'radio_medidas', 'I');
    marcarRadio(doc, 'radio_imagem', 'I');
    marcarRadio(doc, 'radio_descricao', 'I');
    marcarRadio(doc, 'radio_estoque', 'I');
    marcarRadio(doc, 'radio_primeira_entrada', 'N');
    marcarRadio(doc, 'in_controle_promocao', '');
    marcarRadio(doc, 'in_exibir_produto_ecommerce', 'I');

    const sel = doc.querySelector('select[name="id_secao"]');
    const alvoNorm = norm(labelAlvo);
    const opt = Array.from(sel.options).find((o) => norm(o.textContent) === alvoNorm);
    if (!opt) throw new Error(`Seção "${labelAlvo}" não encontrada no dropdown (Compras > Catálogo de Produtos).`);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    win.pesquisar();
  }, labelSecao);

  // Polling EXTERNO do Playwright (numérico) — não setTimeout dentro da
  // página. Mesma lição aprendida no x2-fotos-scraper.js: funciona mesmo
  // com a janela em segundo plano.
  await page.waitForFunction(
    (cabecalho) => document.querySelector('iframe[name="principal"]').contentDocument.body.innerText.includes(cabecalho),
    CABECALHO_RESULTADO,
    { timeout: 30000, polling: 500 }
  );
}

async function extrairTextoResultado(page) {
  return page.evaluate(() => document.querySelector('iframe[name="principal"]').contentDocument.body.innerText);
}

async function extrairDescricaoDetalhada(page, codigo) {
  return page.evaluate((cod) => {
    const doc = document.querySelector('iframe[name="principal"]').contentDocument;
    const ta = doc.querySelector(`textarea[name="ds_descricao_detalhada${cod}"]`);
    return ta ? ta.value : null;
  }, codigo);
}

// ─── Orquestração ───────────────────────────────────────────────────────

// Compara o que já temos salvo contra o que o X2 retornou agora. Pura (sem
// fs/navegador) — testável isoladamente. `novos`: código no X2 mas não no
// JSON. `removidos`: código no JSON mas não mais no X2 (provável produto
// desativado/descontinuado — ver cabeçalho do arquivo).
function calcularDiferenca(existentes, encontrados) {
  const codigosExistentes = new Set(existentes.map((p) => p.codigo));
  const codigosEncontrados = new Set(encontrados.map((p) => p.codigo));
  return {
    novos: encontrados.filter((p) => !codigosExistentes.has(p.codigo)),
    removidos: existentes.filter((p) => !codigosEncontrados.has(p.codigo)),
  };
}

// Pedido do usuário (2026-08-05): "garanta que todos os produtos estão sendo
// capturados precisamente" — se a busca falhar por qualquer motivo (sessão
// caiu, X2 mudou o texto/formato da tela, timeout parcial), o comportamento
// padrão de "não encontrado = desativado, remove" apagaria a seção inteira
// do catálogo por engano. Essa trava só deixa a remoção automática seguir
// quando a fração de "não encontrados" é pequena o bastante pra ser
// descontinuação normal — acima disso, avisa e NÃO remove, mesmo sem
// --sem-remover (precisa confirmar de propósito com --forcar-remocao).
const LIMITE_REMOCAO_SUSPEITA = 0.3; // 30% do catálogo da seção

async function sincronizarSecao(page, secaoSlug, { dryRun, semRemover, forcarRemocao } = {}) {
  const labelSecao = SECOES[secaoSlug];
  if (!labelSecao) {
    throw new Error(`Seção desconhecida: "${secaoSlug}". Opções: ${Object.keys(SECOES).join(', ')}`);
  }

  const jsonPath = path.join(CATALOGO_DIR, `${secaoSlug}.json`);
  const produtosExistentes = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  console.log(`\n=== Seção ${labelSecao} (${secaoSlug}) ===`);
  console.log(`${produtosExistentes.length} produtos já no JSON. Buscando no X2 (sem nenhum filtro além da Seção)...`);

  await buscarSecao(page, labelSecao);
  const texto = await extrairTextoResultado(page);

  // Detecta extração quebrada ANTES de calcular novos/removidos — sem isso,
  // um cabeçalho não encontrado vira silenciosamente "0 produtos", e a lista
  // inteira de existentes cairia em "removidos".
  if (!texto.includes(CABECALHO_RESULTADO)) {
    console.log(`⚠ ATENÇÃO: não encontrei o cabeçalho "${CABECALHO_RESULTADO}" na tela de resultado — a busca pode ter falhado ou o X2 mudou o formato da tela. Pulando "${secaoSlug}" SEM alterar o catálogo (nada foi removido nem adicionado).`);
    return { secaoSlug, novos: 0, removidos: 0, total: produtosExistentes.length, erro: 'cabecalho_nao_encontrado' };
  }

  const encontrados = parsearProdutos(texto);

  const { novos, removidos } = calcularDiferenca(produtosExistentes, encontrados);
  console.log(`${encontrados.length} produtos encontrados no X2 (após deduplicar por código).`);
  console.log(`${novos.length} são NOVOS. ${removidos.length} não foram encontrados mais (prováveis desativados no X2).`);

  const fracaoRemovida = produtosExistentes.length > 0 ? removidos.length / produtosExistentes.length : 0;
  const remocaoSuspeita = !semRemover && !forcarRemocao && removidos.length > 3 && fracaoRemovida > LIMITE_REMOCAO_SUSPEITA;
  if (remocaoSuspeita) {
    console.log(`⚠ ATENÇÃO: ${removidos.length} de ${produtosExistentes.length} produtos (${Math.round(fracaoRemovida * 100)}%) não foram encontrados — é demais pra ser descontinuação normal, pode ser falha na busca. NÃO removendo automaticamente. Revise a lista abaixo; se estiver correta mesmo, rode de novo com --forcar-remocao.`);
  }

  if (!novos.length && !removidos.length) {
    return { secaoSlug, novos: 0, removidos: 0, total: produtosExistentes.length };
  }

  let listaFinal = [...produtosExistentes];

  for (const produto of novos) {
    const descricaoDetalhada = await extrairDescricaoDetalhada(page, produto.codigo);
    listaFinal.push({
      codigo: produto.codigo,
      nome: produto.nome,
      barras: produto.barras,
      secao: produto.secao || labelSecao,
      linha: produto.linha,
      descricaoDetalhada: descricaoDetalhada || null,
      // Decisão consciente (ver cabeçalho do arquivo): sem parser de ficha
      // ainda — null é tratado pelo resto do sistema como "sem ficha".
      ficha: null,
    });
    console.log(`  + ${produto.codigo} — ${produto.nome}`);
  }

  let removidosAplicados = 0;
  if (removidos.length) {
    if (semRemover || remocaoSuspeita) {
      if (semRemover) console.log(`(--sem-remover: mantendo os ${removidos.length} código(s) abaixo mesmo não achando mais no X2 — revise manualmente se quiser)`);
      for (const r of removidos) console.log(`  ? ${r.codigo} — ${r.nome} (não encontrado no X2)`);
    } else {
      const codigosRemover = new Set(removidos.map((r) => r.codigo));
      listaFinal = listaFinal.filter((p) => !codigosRemover.has(p.codigo));
      removidosAplicados = removidos.length;
      for (const r of removidos) console.log(`  - ${r.codigo} — ${r.nome} (não encontrado no X2, removido do catálogo)`);
    }
  }

  if (dryRun) {
    console.log(`(--dry-run: nada foi gravado. +${novos.length} novo(s), -${(semRemover || remocaoSuspeita) ? 0 : removidos.length} removido(s) seriam aplicados a ${secaoSlug}.json)`);
  } else {
    // Backup do JSON antigo antes de sobrescrever — mesmo cuidado já usado
    // pros zips de foto. Nunca sobrescreve sem cópia de segurança.
    const backupPath = `${jsonPath}.bak-${Date.now()}`;
    fs.copyFileSync(jsonPath, backupPath);
    fs.writeFileSync(jsonPath, JSON.stringify(listaFinal, null, 2));
    console.log(`Backup do JSON antigo: ${backupPath}`);
    console.log(`Gravado: ${jsonPath} agora tem ${listaFinal.length} produtos (+${novos.length}${removidosAplicados ? `, -${removidosAplicados}` : ''}).`);
    if (novos.length) console.log('Lembre de rodar o x2-fotos-scraper.js pra esses códigos novos ganharem foto.');
  }

  return { secaoSlug, novos: novos.length, removidos: dryRun ? removidos.length : removidosAplicados, total: listaFinal.length };
}

async function rodar(slugs, { channel, dryRun, semRemover, forcarRemocao, confirmar }) {
  const context = await abrirNavegador(channel);
  const resumo = [];
  try {
    const page = await garantirTelaCatalogoAberta(context, { confirmar });
    for (const secaoSlug of slugs) {
      try {
        resumo.push(await sincronizarSecao(page, secaoSlug, { dryRun, semRemover, forcarRemocao }));
      } catch (e) {
        console.error(`\nErro na seção ${secaoSlug}: ${e.message} — pulando pra próxima.`);
        resumo.push({ secaoSlug, erro: e.message });
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  console.log('\n\n=== Resumo geral ===');
  let totalNovos = 0;
  let totalRemovidos = 0;
  for (const r of resumo) {
    if (r.erro) { console.log(`${r.secaoSlug}: ERRO — ${r.erro}`); continue; }
    console.log(`${r.secaoSlug}: +${r.novos} novo(s), -${r.removidos} removido(s) (total ${r.total})`);
    totalNovos += r.novos;
    totalRemovidos += r.removidos;
  }
  console.log(`\nTotal novos: ${totalNovos}. Total removidos${dryRun ? ' (simulado, --dry-run)' : ''}: ${totalRemovidos}.`);
  if (totalNovos && !dryRun) {
    console.log('Rode o x2-fotos-scraper.js (ou o menu) pra baixar as fotos desses códigos novos.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const secaoArg = args.find((a) => a.startsWith('--secao='));
  const secoesArg = args.find((a) => a.startsWith('--secoes='));
  const todas = args.includes('--todas');
  const channelArg = args.find((a) => a.startsWith('--channel='));
  const dryRun = args.includes('--dry-run');
  const semRemover = args.includes('--sem-remover');
  const forcarRemocao = args.includes('--forcar-remocao');

  const channel = channelArg ? channelArg.split('=')[1] : 'chrome';

  if (!secaoArg && !secoesArg && !todas) {
    console.log('Uso:');
    console.log('  node scripts/x2-catalogo-sync.js --secao=<slug> [--dry-run] [--sem-remover] [--channel=chrome|msedge]');
    console.log('  node scripts/x2-catalogo-sync.js --secoes=<slug1>,<slug2>,... [--dry-run] [--sem-remover]');
    console.log('  node scripts/x2-catalogo-sync.js --todas [--dry-run] [--sem-remover]');
    console.log('\nPor padrão, código que já está no JSON mas não é mais encontrado no X2 é REMOVIDO');
    console.log('(provável produto desativado) — com backup automático do JSON antigo. Use');
    console.log('--sem-remover pra só acrescentar produtos novos, sem nunca remover nada.');
    console.log(`\nSe mais de ${Math.round(LIMITE_REMOCAO_SUSPEITA * 100)}% dos produtos de uma seção "sumirem" de uma vez, o script`);
    console.log('trava a remoção automática por segurança (provável falha na busca, não descontinuação');
    console.log('de verdade) e só lista os códigos — use --forcar-remocao pra confirmar que é intencional.');
    console.log('\nSeções disponíveis:');
    console.log(Object.keys(SECOES).map((s) => `  ${s}`).join('\n'));
    process.exit(1);
  }

  let slugs;
  if (todas) slugs = Object.keys(SECOES);
  else if (secoesArg) slugs = secoesArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  else slugs = [secaoArg.split('=')[1]];

  const desconhecidos = slugs.filter((s) => !SECOES[s]);
  if (desconhecidos.length) {
    throw new Error(`Seção(ões) desconhecida(s): ${desconhecidos.join(', ')}. Opções: ${Object.keys(SECOES).join(', ')}`);
  }

  await rodar(slugs, { channel, dryRun, semRemover, forcarRemocao });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { parsearProdutos, calcularDiferenca, CABECALHO_RESULTADO, rodar, LIMITE_REMOCAO_SUSPEITA };
