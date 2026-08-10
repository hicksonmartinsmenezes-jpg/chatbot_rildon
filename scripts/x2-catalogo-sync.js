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

// Sem isso, X2_USUARIO/X2_SENHA só carregavam quando este script rodava
// DENTRO do server.js — rodando direto pelo terminal, process.env ficava
// vazio. Confirmado ao vivo 2026-08-06 (ver x2-estoque-export.js).
require('dotenv').config({ path: path.join(__dirname, '../.env') });

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
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless: false, viewport: null });
  // Ver x2-fotos-scraper.js pro relato completo (navigator.webdriver=true
  // confirmado ao vivo 2026-08-06 como causa do botão "Catálogo de
  // Produtos" não responder nem a clique humano de verdade).
  const { esconderWebdriver } = require('./x2-fotos-scraper');
  await esconderWebdriver(context);
  return context;
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
//
// `modoAutomatico` (2026-08-06, feature "Rotinas"): tenta logar sozinho e
// depois chega em "Compras > Catálogo de Produtos" clicando pelo MENU de
// verdade (☰ > tile "Compras" > link "Catálogo de Produtos").
//
// ⚠️ Atualizado em 2026-08-06 (sessão de descoberta ao vivo, ver
// scripts/x2-estoque-export.js pro relato completo): a versão anterior
// desta função desistia aqui porque "não tinha URL direta confirmada" —
// hoje SEI a URL real (`../compra/catalogo_produto/catalogo_pesquisa.jsp`,
// vista no DOM do menu), mas também confirmei que navegação DIRETA por URL
// é bloqueada pelo servidor em qualquer tela profunda do X2 ("Você não
// está autorizado a continuar"). Ou seja, a URL nunca teria funcionado de
// qualquer forma — o caminho certo é sempre clicar pelo menu, que É
// automatizável (confirmado ao vivo pros cliques de ☰/tile/link).
async function garantirTelaCatalogoAberta(context, { confirmar, modoAutomatico } = {}) {
  for (const page of context.pages()) {
    if (await telaTemFormulario(page)) return page;
  }

  const page = context.pages()[0] || (await context.newPage());
  if (!page.url().includes('xprocess.com.br')) {
    await page.goto(LOGIN_URL).catch(() => {});
  }

  if (modoAutomatico) {
    const pareceLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
    if (pareceLogin) {
      const { tentarLoginAutomatico } = require('./x2-fotos-scraper');
      await tentarLoginAutomatico(page);
    }

    // ⚠️ Corrigido 2026-08-06: NÃO dar goto() direto pro index_main4.jsp
    // depois do login — mesma trava de "acesso direto não permitido" que já
    // bloqueava telas profundas também bloqueia essa URL como navegação
    // "fria" (confirmado ao vivo testando x2-estoque-export.js, apareceu
    // "Gerenciamento de Acesso / Acesso Negado!"). Clica o menu direto de
    // onde o login deixou a página (o X2 já redireciona pra home sozinho).
    await page.waitForTimeout(500);
    await page.locator('a').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('a:has-text("Compras")').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('a[href*="catalogo_produto/catalogo_pesquisa.jsp"]').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);

    for (const p of context.pages()) {
      if (await telaTemFormulario(p)) return p;
    }
    throw new Error('Modo automático: cliquei pelo menu (☰ > Compras > Catálogo de Produtos) mas o formulário não apareceu — precisa de uma sessão supervisionada pra confirmar/ajustar os seletores usados na navegação.');
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

// PEDIDO DO USUÁRIO (2026-08-10): "com a lista csv que eu extraio, não
// seria mais fácil capturar códigos novos por lá e depois rastreá-los com
// o sync" — em vez de re-varrer as 26 seções inteiras (caro, e foi o que
// travou o servidor no dia 10/08 numa rodada --todas), busca cada código
// INDIVIDUALMENTE pelo campo "Código do Produto" (`id_produto`), com Seção
// = Todos. O resultado já traz "Seção > Linha" no texto — parsearProdutos
// já sabia ler isso, não precisou de nenhuma mudança nessa parte — então
// descobrimos a seção certa sem precisar adivinhar nem escanear tudo.
// Mesmo reset de filtros de buscarSecao() (duplicado de propósito — cada
// page.evaluate() roda isolado no contexto da página, então compartilhar a
// função helper entre as duas exigiria injeção extra sem ganho real pra um
// bloco desse tamanho).
// ⚠️ Corrigido 2026-08-10 (falha ao vivo: rodando --diff-estoque pra 86
// códigos em sequência, só o 1º achou resultado certo — os outros 85
// vieram "não encontrado" mesmo devendo existir). Causa: o waitForFunction
// só checava "o cabeçalho de resultado apareceu" — se a busca ANTERIOR já
// tinha deixado esse cabeçalho na tela, a promise resolvia IMEDIATAMENTE,
// antes da busca do código atual terminar de verdade, e extrairTextoResultado
// lia o resultado do código ANTERIOR (que não bate com o código atual no
// filter de sincronizarPorCodigos, então virava "não encontrado" por
// engano). Fix: tira um "retrato" do texto ANTES de disparar a busca, e só
// considera pronto quando o texto muda desse retrato E bate um dos padrões
// esperados — garante que é resultado da busca ATUAL, não da anterior.
async function buscarPorCodigo(page, codigo) {
  const textoAntes = await extrairTextoResultado(page).catch(() => '');

  await page.evaluate((cod) => {
    function marcarRadio(doc, name, valor) {
      const el = doc.querySelector(`input[name="${name}"][value="${valor}"]`);
      if (el) el.checked = true;
    }
    const frame = document.querySelector('iframe[name="principal"]');
    const doc = frame.contentDocument;
    const win = frame.contentWindow;

    for (const nome of ['ds_descricao_comercial', 'cd_barras', 'dt_inicio', 'dt_fim', 'dt_inicio_recebimento', 'dt_fim_recebimento']) {
      const el = doc.querySelector(`input[name="${nome}"]`);
      if (el) el.value = '';
    }
    for (const nome of ['id_empresa', 'id_linha', 'id_sub_linha', 'id_fornecedor_pesq', 'id_fabricante_pesq']) {
      const el = doc.querySelector(`select[name="${nome}"]`);
      if (el) el.value = '';
    }
    marcarRadio(doc, 'radio_medidas', 'I');
    marcarRadio(doc, 'radio_imagem', 'I');
    marcarRadio(doc, 'radio_descricao', 'I');
    marcarRadio(doc, 'radio_estoque', 'I');
    marcarRadio(doc, 'radio_primeira_entrada', 'N');
    marcarRadio(doc, 'in_controle_promocao', '');
    marcarRadio(doc, 'in_exibir_produto_ecommerce', 'I');

    const selSecao = doc.querySelector('select[name="id_secao"]');
    if (selSecao) selSecao.value = ''; // Todos — deixa o X2 dizer qual é a seção certa

    const idProdutoEl = doc.querySelector('input[name="id_produto"]');
    if (!idProdutoEl) throw new Error('Campo "Código do Produto" (id_produto) não encontrado no formulário.');
    idProdutoEl.value = cod;

    win.pesquisar();
  }, codigo);

  // Sem cabeçalho garantido quando o código não existe (tela pode só voltar
  // vazia) — por isso aqui o timeout NÃO é fatal, quem chama decide olhando
  // o texto extraído depois (ver sincronizarPorCodigos). `texto !== anterior`
  // é a parte que garante que não estamos lendo resultado velho (ver
  // comentário acima de buscarPorCodigo).
  // 6s (não 15s): se a tela de "nenhum resultado" for IDÊNTICA pra qualquer
  // código sem match (sem nada específico do código na mensagem — bem
  // provável), `texto !== anterior` nunca vira true de propósito quando 2
  // códigos seguidos não são encontrados, e sempre estoura o timeout — com
  // 85 códigos "não encontrados" numa rodada só, 15s cada vira ~20min. Cai
  // no .catch() de qualquer jeito (resultado correto: "não encontrado"
  // continua válido mesmo por timeout), só reduz a espera desperdiçada.
  await page.waitForFunction(
    (anterior) => {
      const doc = document.querySelector('iframe[name="principal"]').contentDocument;
      const texto = doc.body.innerText;
      if (texto === anterior) return false;
      return /Produto\tDescrição detalhada\tVolumetria|nenhum resultado|não foi encontrado/i.test(texto);
    },
    textoAntes,
    { timeout: 6000, polling: 300 }
  ).catch(() => {});
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

// Mapa label X2 ("ALTERNADOR") -> slug do nosso catálogo ("alternador"),
// pro sentido inverso de SECOES (slug -> label). Normaliza igual ao resto
// do arquivo pra não depender de acento/maiúscula bater exatamente.
function _normLabel(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}
const LABEL_PARA_SLUG = Object.fromEntries(
  Object.entries(SECOES).map(([slug, label]) => [_normLabel(label), slug])
);

// PEDIDO DO USUÁRIO (2026-08-10) — ver comentário de buscarPorCodigo().
// Busca uma LISTA de códigos individualmente (1 pesquisa por código, Seção
// = Todos), agrupa os achados por seção (usando o texto "Seção > Linha" que
// o próprio X2 devolve) e GRAVA direto no <slug>.json certo — sem precisar
// escanear a seção inteira. Só adiciona (nunca remove nada aqui: um código
// "não encontrado" nessa busca pontual não prova que o produto foi
// descontinuado — pode ser erro de digitação, item sem cadastro completo
// no X2, etc. — fica só num aviso pro usuário decidir).
async function sincronizarPorCodigos(page, codigos, { dryRun } = {}) {
  const porSecao = new Map(); // slug -> [produto, ...]
  const naoEncontrados = [];
  const semSecaoReconhecida = [];

  for (const codigo of codigos) {
    await buscarPorCodigo(page, codigo);
    const texto = await extrairTextoResultado(page);
    const encontrados = parsearProdutos(texto).filter((p) => p.codigo === String(codigo).trim());

    if (!encontrados.length) {
      console.log(`  ? ${codigo} — não encontrado na busca individual do X2 (confira se o código está certo).`);
      naoEncontrados.push(codigo);
      continue;
    }

    const produto = encontrados[0];
    const slug = produto.secao ? LABEL_PARA_SLUG[_normLabel(produto.secao)] : null;
    if (!slug) {
      console.log(`  ? ${codigo} — ${produto.nome} — achei no X2 (Seção: "${produto.secao || '?'}") mas não bate com nenhuma das 26 seções conhecidas. Precisa mapear manualmente.`);
      semSecaoReconhecida.push({ codigo, produto });
      continue;
    }

    const descricaoDetalhada = await extrairDescricaoDetalhada(page, produto.codigo);
    const novoProduto = {
      codigo: produto.codigo,
      nome: produto.nome,
      barras: produto.barras,
      secao: produto.secao,
      linha: produto.linha,
      descricaoDetalhada: descricaoDetalhada || null,
      ficha: null, // mesma decisão consciente do resto do arquivo (ver cabeçalho)
    };
    if (!porSecao.has(slug)) porSecao.set(slug, []);
    porSecao.get(slug).push(novoProduto);
    console.log(`  + ${codigo} — ${produto.nome} (${SECOES[slug]})`);
  }

  const gravados = [];
  for (const [slug, produtosNovos] of porSecao.entries()) {
    const jsonPath = path.join(CATALOGO_DIR, `${slug}.json`);
    const existentes = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const codigosExistentes = new Set(existentes.map((p) => p.codigo));
    const paraAdicionar = produtosNovos.filter((p) => !codigosExistentes.has(p.codigo));

    if (!paraAdicionar.length) continue;

    if (dryRun) {
      console.log(`(--dry-run: +${paraAdicionar.length} produto(s) seriam adicionados a ${slug}.json)`);
    } else {
      const backupPath = `${jsonPath}.bak-${Date.now()}`;
      fs.copyFileSync(jsonPath, backupPath);
      const listaFinal = [...existentes, ...paraAdicionar];
      fs.writeFileSync(jsonPath, JSON.stringify(listaFinal, null, 2));
      console.log(`Backup: ${backupPath}`);
      console.log(`Gravado: ${jsonPath} agora tem ${listaFinal.length} produtos (+${paraAdicionar.length}).`);
    }
    gravados.push({ slug, adicionados: paraAdicionar.length });
  }

  return { gravados, naoEncontrados, semSecaoReconhecida };
}

// Lê o CSV do Relatório de Estoque (mesmo formato de x2-estoque-export.js,
// parseado com a MESMA função já usada/testada pelo import pro Postgres —
// ver src/services/estoque.service.js) e compara com os códigos que já
// estão no catálogo de fotos. Só retorna os que faltam (o resto do fluxo
// cuida de buscar e gravar cada um).
function codigosFaltandoNoCatalogo(caminhoCsv) {
  const { parseCsvEstoque } = require('../src/services/estoque.service');
  const conteudo = fs.readFileSync(caminhoCsv, 'utf8');
  const registros = parseCsvEstoque(conteudo);
  const codigosEstoque = new Set(registros.map((r) => r.codigo));

  const codigosCatalogo = new Set();
  for (const slug of Object.keys(SECOES)) {
    try {
      const produtos = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8'));
      for (const p of produtos) codigosCatalogo.add(String(p.codigo).trim());
    } catch { /* json não encontrado ainda */ }
  }

  return [...codigosEstoque].filter((c) => !codigosCatalogo.has(c)).sort();
}

async function rodar(slugs, { channel, dryRun, semRemover, forcarRemocao, confirmar, modoAutomatico }) {
  const context = await abrirNavegador(channel);
  const resumo = [];
  try {
    const page = await garantirTelaCatalogoAberta(context, { confirmar, modoAutomatico });
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

// PEDIDO DO USUÁRIO (2026-08-10) — ver comentário de sincronizarPorCodigos.
// Fluxo ponta-a-ponta: acha o CSV de estoque mais recente (ou o caminho
// passado em --diff-estoque=<caminho>), calcula quais códigos existem no
// estoque real mas ainda não estão em nenhum <seção>.json, e busca só
// ESSES no X2 — sem escanear as 26 seções inteiras.
async function rodarDiffEstoque({ caminhoCsv, channel, dryRun, confirmar, modoAutomatico }) {
  let csvFinal = caminhoCsv;
  if (!csvFinal) {
    // Mesmo diretório usado por x2-estoque-export.js (~/.x2-rildon-scraper/estoque/).
    const { ESTOQUE_DIR, carregarExports } = require('./x2-estoque-export');
    const exports = carregarExports();
    if (!exports.length) throw new Error(`Nenhum CSV de estoque encontrado em ${ESTOQUE_DIR} — rode x2-estoque-export.js primeiro, ou passe --diff-estoque=<caminho>.`);
    csvFinal = path.join(ESTOQUE_DIR, exports[0].nome); // já vem ordenado do mais recente
  }

  console.log(`Comparando catálogo de fotos com: ${csvFinal}`);
  const faltando = codigosFaltandoNoCatalogo(csvFinal);
  console.log(`${faltando.length} código(s) no estoque que ainda não estão no catálogo de fotos.`);
  if (!faltando.length) {
    console.log('Nada a fazer — catálogo já cobre todo o estoque.');
    return;
  }
  console.log(faltando.join(', '));

  const context = await abrirNavegador(channel);
  try {
    const page = await garantirTelaCatalogoAberta(context, { confirmar, modoAutomatico });
    const resultado = await sincronizarPorCodigos(page, faltando, { dryRun });

    console.log('\n=== Resumo ===');
    for (const g of resultado.gravados) console.log(`${g.slug}: +${g.adicionados} produto(s)`);
    if (resultado.naoEncontrados.length) console.log(`Não encontrados no X2: ${resultado.naoEncontrados.join(', ')}`);
    if (resultado.semSecaoReconhecida.length) console.log(`Seção não reconhecida (precisa checar manualmente): ${resultado.semSecaoReconhecida.map((s) => s.codigo).join(', ')}`);
    const totalAdicionado = resultado.gravados.reduce((a, g) => a + g.adicionados, 0);
    if (totalAdicionado && !dryRun) console.log('\nLembre de rodar o x2-fotos-scraper.js pra esses códigos novos ganharem foto.');
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const secaoArg = args.find((a) => a.startsWith('--secao='));
  const secoesArg = args.find((a) => a.startsWith('--secoes='));
  const todas = args.includes('--todas');
  const diffEstoque = args.includes('--diff-estoque') || args.some((a) => a.startsWith('--diff-estoque='));
  const diffEstoqueArg = args.find((a) => a.startsWith('--diff-estoque='));
  const channelArg = args.find((a) => a.startsWith('--channel='));
  const dryRun = args.includes('--dry-run');
  const semRemover = args.includes('--sem-remover');
  const forcarRemocao = args.includes('--forcar-remocao');

  const channel = channelArg ? channelArg.split('=')[1] : 'chrome';

  if (diffEstoque) {
    const caminhoCsv = diffEstoqueArg ? diffEstoqueArg.split('=').slice(1).join('=') : null;
    await rodarDiffEstoque({ caminhoCsv, channel, dryRun, modoAutomatico: true });
    return;
  }

  if (!secaoArg && !secoesArg && !todas) {
    console.log('Uso:');
    console.log('  node scripts/x2-catalogo-sync.js --secao=<slug> [--dry-run] [--sem-remover] [--channel=chrome|msedge]');
    console.log('  node scripts/x2-catalogo-sync.js --secoes=<slug1>,<slug2>,... [--dry-run] [--sem-remover]');
    console.log('  node scripts/x2-catalogo-sync.js --todas [--dry-run] [--sem-remover]');
    console.log('  node scripts/x2-catalogo-sync.js --diff-estoque[=<caminho.csv>] [--dry-run]  (usa o CSV de estoque mais recente por padrão;');
    console.log('                                                                                busca SÓ os códigos novos, 1 por 1 — não escaneia as 26 seções)');
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

  // PEDIDO DO USUÁRIO (2026-08-06): mesma correção validada ao vivo no
  // x2-estoque-export.js — rodar via terminal deve logar sozinho
  // (X2_USUARIO/X2_SENHA no .env), sem pausar esperando Enter. Diferente do
  // x2-fotos-scraper.js, esta tela (Compras > Catálogo de Produtos) NÃO tem
  // o bloqueio de clique conhecido do popup de fotos — por isso aqui dá pra
  // automatizar 100%, do login até o cadastro dos produtos novos.
  await rodar(slugs, { channel, dryRun, semRemover, forcarRemocao, modoAutomatico: true });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  parsearProdutos,
  calcularDiferenca,
  CABECALHO_RESULTADO,
  rodar,
  LIMITE_REMOCAO_SUSPEITA,
  codigosFaltandoNoCatalogo,
  sincronizarPorCodigos,
  rodarDiffEstoque,
};
