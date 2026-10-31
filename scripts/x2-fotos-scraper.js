#!/usr/bin/env node
/**
 * scripts/x2-fotos-scraper.js
 *
 * PEDIDO DO USUÁRIO (2026-07-27): "é possível criar uma ferramenta que faça
 * exatamente isso que está fazendo?" — a rotina "Atualizar fotos Produtos"
 * (ver memória do projeto) vinha sendo feita por mim manualmente, produto
 * por produto, via automação de navegador conduzida pelo chat. Este script
 * substitui isso por um processo que roda sozinho no terminal, direto no
 * seu computador, MUITO mais rápido (sem o vai-e-vem de cada chamada de
 * chat) — mas com uma limitação que não dá pra contornar: o botão que abre
 * o popup "Catálogo de Produtos" no X2 exige um clique de verdade seu (o
 * próprio X2 bloqueia clique automatizado nesse botão específico — nem
 * Playwright/Puppeteer contorna isso de forma confiável). Então o fluxo é:
 * você roda o script, ele abre uma janela de Chrome de verdade, você faz
 * login (se precisar) e clica em Vendas 3.0 > Produção de Vendas >
 * "Catálogo de Produtos", aperta Enter no terminal — e o script assume a
 * partir daí sozinho, sem precisar de mais nenhum clique seu.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   npm install                              (só na 1ª vez, instala o Playwright)
 *   node scripts/x2-fotos-scraper.js --secao=componentes-eletricos
 *   node scripts/x2-fotos-scraper.js --secao=componentes-eletricos --limit=20   (testar com poucos primeiro)
 *   node scripts/x2-fotos-scraper.js --secao=componentes-eletricos --build-zip  (só depois que TODOS os produtos da seção estiverem processados)
 *   node scripts/x2-fotos-scraper.js --secoes=farois,filtros,lampadas          (várias seções escolhidas, 1 login só)
 *   node scripts/x2-fotos-scraper.js --todas                                   (as 26 seções, uma atrás da outra, 1 login só)
 *   node scripts/x2-fotos-scraper.js --secao=gerador --retry-sem-foto           (tenta de novo os já marcados sem_foto/placeholder/erro/nao_encontrado_na_tabela/frame_foto_nao_bateu, caso o X2 tenha cadastrado a foto depois ou a busca tenha falhado por instabilidade — não descobre produto NOVO)
 *   node scripts/x2-fotos-scraper.js --secao=gerador --reiniciar                (PEDIDO DO USUÁRIO 2026-07-30: apaga o progresso salvo e o staging dessa seção, baixa tudo de novo do zero — ignora o que já tinha sido feito)
 *   node scripts/x2-fotos-scraper.js --secao=gerador --exportar-fotos          (só depois que TODOS os produtos da seção estiverem processados — copia as fotos soltas, sem zip, pra src/config/catalogo-x2/fotos/<secao>/<codigo>/)
 *
 * Rodar de novo com o MESMO --secao (ou --secoes/--todas) continua de onde
 * parou (o progresso é salvo fora da pasta do projeto — ver WORK_DIR abaixo
 * — então não perde nada mesmo fechando o terminal no meio). Nos modos
 * --secoes/--todas, o clique de login/popup só acontece 1 VEZ no início —
 * depois disso ele passa sozinho de seção em seção sem pedir mais nada.
 *
 * ─── Onde ficam os arquivos temporários, e por quê ─────────────────────
 * Perfil do Chrome (login salvo), fotos baixadas EM ANDAMENTO e o registro
 * de progresso ficam em `~/.x2-rildon-scraper/`, FORA da pasta do projeto
 * de propósito — a pasta do projeto está dentro do OneDrive, e escrever
 * centenas/milhares de arquivos pequenos ali (uma foto de cada vez, ao
 * longo de uma seção inteira) trava o sync do OneDrive (mesmo problema já
 * registrado na memória do projeto, "OneDrive file sync corruption"). Só
 * quando a seção INTEIRA estiver processada é que este script escreve UM
 * único arquivo novo dentro do projeto: o `.zip` final da seção em
 * `src/config/catalogo-x2/fotos/<secao>.zip` (com backup do zip antigo).
 *
 * ─── Técnica usada (tudo validado ao vivo em 2026-07-27, ver também
 * memória "reference-x2-download-fotos-tecnica") ────────────────────────
 * - Busca TODOS os produtos de uma Seção de uma vez (dropdown "Seção" +
 *   pesquisar()), em vez de buscar um código por vez — mais rápido.
 * - Pra cada produto: acha o link na tabela de resultado e navega o iframe
 *   de detalhe (`frame_foto`) setando `.src` DIRETO (clicar no link
 *   funciona só na primeira vez da sessão do navegador — depois disso,
 *   clique simplesmente para de navegar o frame, sem erro nenhum — motivo
 *   exato não confirmado, mas o fix funciona de forma consistente).
 * - Detecta o placeholder "imagem não disponível" do X2 (sempre exatamente
 *   1200x1200px, sem "Previous"/"Next" de carrossel) e NÃO baixa isso como
 *   se fosse foto real.
 * - Espera por navegação/AJAX usando o polling EXTERNO do Playwright
 *   (`waitForFunction` com `polling` numérico, chamado repetidamente pelo
 *   processo Node via CDP) — não um polling `setTimeout` DENTRO da página.
 *   Isso importa: uma versão anterior desta técnica (feita manualmente via
 *   chat) usava polling dentro da página e falhava silenciosamente sempre
 *   que a aba não estava em primeiro plano, porque o Chrome throttla
 *   agressivamente os timers de abas em segundo plano.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { chromium } = require('playwright');
const { criarZip } = require('../src/utils/zip-writer');
const { listarEntradas: listarEntradasZip, extrairArquivo: extrairArquivoZip } = require('../src/utils/zip-reader');

// Sem isso, X2_USUARIO/X2_SENHA só carregavam quando este script rodava
// DENTRO do server.js (que já dá o require de dotenv) — rodando direto
// pelo terminal, process.env ficava vazio. Confirmado ao vivo 2026-08-06
// (ver x2-estoque-export.js pro relato completo).
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PROJECT_ROOT = path.join(__dirname, '..');
const CATALOGO_DIR = path.join(PROJECT_ROOT, 'src', 'config', 'catalogo-x2');
const FOTOS_DIR = path.join(CATALOGO_DIR, 'fotos');

// Fora do OneDrive de propósito — ver comentário do topo do arquivo.
const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
// 2026-10-14: perfil por tipo de tarefa — ver scripts/x2-perfil-chrome.js.
// Antes todos compartilhavam 'chrome-profile', e duas tarefas simultaneas
// derrubavam uma a outra ("Target page, context or browser has been closed").
const PROFILE_DIR = require('./x2-perfil-chrome').perfilChrome('fotos');
const STAGING_DIR = path.join(WORK_DIR, 'staging');
const PROGRESS_DIR = path.join(WORK_DIR, 'progress');

const POPUP_URL_MARK = 'vendas/catalogo/catalogo_pesquisa.jsp';
const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';

// Nome do arquivo JSON/zip (slug) → texto EXATO da opção no dropdown
// "Seção" do X2 (comparado de forma normalizada — sem acento, maiúsculo —
// então pequenas diferenças de acentuação entre este mapa e o X2 real não
// quebram a busca).
const SECOES = {
  'acessorios-ferramentas': 'ACESSÓRIOS/FERRAMENTAS',
  'alternador': 'ALTERNADOR',
  'buzinas': 'BUZINAS',
  'cabos-fios-espaguetes': 'CABOS, FIOS E ESPAGUETES',
  'chave-ignicao-trava': 'CHAVE DE IGNIÇÃO E TRAVA',
  'chave-luz-seta-limpador': 'CHAVE DE LUZ, SETA, LIMPADOR',
  'componentes-eletricos': 'COMPONENTES ELÉTRICOS',
  // PEDIDO DO USUÁRIO (2026-08-11): reverte a exclusão original de
  // 2026-07-20 (ver README de src/config/catalogo-x2/) — "Consumo" era uma
  // das 3 categorias internas de estoque (junto com Imobilizado e Padrão)
  // deixadas de fora por não serem produto vendável. Decisão nova: incluir
  // mesmo assim, pra novos itens dessa seção já entrarem categorizados
  // automaticamente no sync. Imobilizado/Padrão continuam de fora — não
  // foram pedidas.
  'consumo': 'CONSUMO',
  'distribuidor': 'DISTRIBUIDOR',
  'engates-reboques': 'ENGATES E REBOQUES',
  'farois': 'FARÓIS',
  'filtros': 'FILTROS',
  'gerador': 'GERADOR',
  'injecao-eletronica': 'INJEÇÃO ELETRÔNICA',
  'instrumento-painel': 'INSTRUMENTO DE PAINEL',
  'interruptores-acionamento': 'INTERRUPTORES DE ACIONAMENTO',
  'interruptores-sensores-valvulas': 'INTERRUPTORES, SENSORES E VÁLVULAS',
  'lampadas': 'LÂMPADAS',
  'lentes-lanternas': 'LENTES E LANTERNAS',
  'mecanica': 'MECÂNICA',
  'motor-partida': 'MOTOR DE PARTIDA',
  'motores-resistencias': 'MOTORES E RESISTÊNCIAS',
  'quimica': 'QUÍMICA',
  'reles-modulos-eletronicos': 'RELÉS E MÓDULOS ELETRÔNICOS',
  'sistema-ignicao': 'SISTEMA DE IGNIÇÃO',
  'soquetes-conectores': 'SOQUETES/CONECTORES',
  'terminais-luvas': 'TERMINAIS E LUVAS',
};

function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resp) => { rl.close(); resolve(resp); }));
}

function garantirPastas() {
  for (const d of [WORK_DIR, PROFILE_DIR, STAGING_DIR, PROGRESS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

function progressPath(secaoSlug) {
  return path.join(PROGRESS_DIR, `${secaoSlug}.json`);
}

function carregarProgresso(secaoSlug) {
  const p = progressPath(secaoSlug);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function salvarProgresso(secaoSlug, progresso) {
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  fs.writeFileSync(progressPath(secaoSlug), JSON.stringify(progresso, null, 2));
}

function stagingSecaoDir(secaoSlug) {
  return path.join(STAGING_DIR, secaoSlug);
}

// Pedido do usuário (2026-07-30): "faça tudo novamente" — apaga o progresso
// salvo (o .json em PROGRESS_DIR) e as fotos já baixadas no staging dessa
// seção, fazendo o próximo `calcularFila` tratar TODOS os códigos como
// pendentes de novo, do zero. Não mexe no .zip/pasta já exportados
// anteriormente pro projeto — só reseta o processo de baixar de novo; a
// exportação final (montarZipFinal/exportarFotosSoltas) sobrescreve quando
// rodar de novo depois.
function reiniciarSecao(secaoSlug) {
  const p = progressPath(secaoSlug);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const dir = stagingSecaoDir(secaoSlug);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Navegador ──────────────────────────────────────────────────────────

async function abrirNavegador(channel) {
  garantirPastas();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel,
    headless: false,
    viewport: null,
  });
  await esconderWebdriver(context);
  return context;
}

// ⚠️ Descoberto ao vivo 2026-08-06 (pedido do usuário: testando o clique
// em "Catálogo de Produtos" que sempre falhou automatizado — inclusive
// clicando com o MOUSE de verdade dentro dessa janela do Chrome, ainda
// falhava). Rodando `navigator.webdriver` no console da janela do
// Playwright, o usuário confirmou `true`. Isso explica o "bloqueio": não é
// o clique em si (automatizado vs humano) que o X2 rejeita nesse botão —
// é a página detectando que está rodando num navegador controlado por
// automação (CDP/Playwright) e desativando essa ação específica pra
// QUALQUER clique nessa janela. Escondendo essa flag (técnica padrão do
// Playwright, não é exploração de falha nenhuma — só faz o navegador não
// se anunciar como automatizado), o clique humano real deve voltar a
// funcionar normalmente.
async function esconderWebdriver(context) {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

// PEDIDO DO USUÁRIO (2026-08-06, feature "Rotinas"): pra uma rotina rodar
// sozinha de madrugada sem ninguém na frente, o próprio usuário revelou uma
// trava adicional: o X2 tem timeout de sessão de login, então uma janela
// deixada aberta simplesmente cai sozinha entre uma execução e outra — não
// basta manter o navegador aberto, o script precisa logar de novo sozinho a
// cada rotina.
//
// ⚠️ NÃO VALIDADO AO VIVO — diferente do resto deste arquivo (que foi todo
// confirmado clicando de verdade no X2), o formulário de login nunca foi
// inspecionado numa sessão real. A heurística abaixo usa o primeiro
// input[type=text|email] visível como campo de usuário e o input[type=password]
// como senha, em vez de um seletor fixo (mais chance de acertar sem saber o
// name= exato) — mas a primeira rotina configurada precisa ser observada uma
// vez (rodar manualmente e olhar o navegador abrir) pra confirmar que loga
// mesmo. Se não achar os campos, falha com erro claro em vez de travar
// esperando um Enter que numa rotina automática nunca vem.
async function tentarLoginAutomatico(page) {
  const usuario = process.env.X2_USUARIO;
  const senha = process.env.X2_SENHA;
  if (!usuario || !senha) {
    throw new Error('Modo automático (rotina) precisa de X2_USUARIO e X2_SENHA configurados no .env — sem isso não dá pra logar sozinho no X2.');
  }
  if (!page.url().includes('xprocess.com.br')) {
    await page.goto(LOGIN_URL).catch(() => {});
  }
  // Confirmado ao vivo 2026-08-06 (inspeção do DOM real da tela de login via
  // extensão do Chrome, depois de 2 tentativas "Acesso negado" seguidas):
  // além de ter DOIS pares usuário/senha (o de mudar senha, escondido,
  // name="matricula2"/"senha2"; e o de login de verdade, visível,
  // name="matricula"/"senha"), a página tem IDs DUPLICADOS de verdade —
  // id="email" aparece 2x, id="pwd" aparece 4x (bug da própria tela do X2).
  // Se o onclick="verificarSenha()" usa getElementById('email'/'pwd') por
  // dentro, ele sempre pega o PRIMEIRO da página (o campo escondido, vazio)
  // não importa qual eu preencha por name= — foi exatamente por isso que
  // preencher só o campo certo por name= (tentativa anterior) ainda deu
  // "Acesso negado". Por isso preenche os DOIS pares (visível + escondido)
  // com o mesmo valor, cobrindo os dois jeitos de ler o campo — sem tocar
  // em nova_senha/nova_senha_confirma (pra não disparar troca de senha).
  // O botão de submit também não é um <form> comum — é um <a>"Acessar" com
  // onclick="verificarSenha()" (existe um 2º "Acessar" ESCONDIDO de outro
  // fluxo, por isso o clique tem que ser no visível).
  const preenchido = await page.evaluate(({ usuario, senha }) => {
    const preencher = (el) => {
      if (!el) return false;
      el.value = usuario;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const preencherSenha = (el) => {
      if (!el) return false;
      el.value = senha;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const campoUsuario = document.querySelector('input[name="matricula"]');
    const campoUsuario2 = document.querySelector('input[name="matricula2"]');
    const campoSenha = document.querySelector('input[name="senha"]');
    const campoSenha2 = document.querySelector('input[name="senha2"]');
    if (!campoUsuario || !campoSenha) return { ok: false, erro: 'campos de usuário/senha (matricula/senha) não encontrados' };
    preencher(campoUsuario);
    preencher(campoUsuario2);
    preencherSenha(campoSenha);
    preencherSenha(campoSenha2);
    const visivel = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const acessar = Array.from(document.querySelectorAll('a')).find((a) => a.textContent.trim() === 'Acessar' && visivel(a));
    if (acessar) {
      acessar.click();
      return { ok: true };
    }
    const form = campoSenha.closest('form');
    if (form) {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
      return { ok: true };
    }
    return { ok: false, erro: 'nem o botão "Acessar" nem um <form> foram encontrados' };
  }, { usuario, senha });
  if (!preenchido.ok) {
    throw new Error(`Login automático: ${preenchido.erro} — a tela de login do X2 pode ter mudado, precisa confirmar ao vivo.`);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2000);

  // Verificação explícita — sem isso, um login que falha silenciosamente
  // só aparece depois, com um erro confuso de "não achei tal botão" 2
  // passos adiante (foi exatamente o que aconteceu na 1ª tentativa).
  const aindaNaLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (aindaNaLogin) {
    throw new Error('Login automático: preenchi os campos e cliquei em "Acessar", mas ainda pareço estar na tela de login — confira se X2_USUARIO/X2_SENHA no .env estão corretos.');
  }
}

// Acha o popup já aberto, ou pausa pedindo pro usuário logar/clicar. Só
// precisa disso 1x por execução do script — depois de achar, guarda a
// referência e reusa pra todos os produtos da seção.
//
// Pedido do usuário (2026-08-05): o painel visual (scripts/x2-painel/) roda
// esse MESMO fluxo só que sem terminal pra digitar Enter — em vez de travar
// num readline, ele passa `confirmar` (uma função que só resolve quando o
// usuário clica "Já cliquei, continuar" na página). Parâmetro opcional: se
// não vier nada, cai no comportamento de sempre (readline no terminal),
// então o menu/CLI continuam idênticos a antes.
//
// `modoAutomatico` (2026-08-06, feature "Rotinas"): pula QUALQUER pausa
// humana — tenta logar sozinho (se a tela de login aparecer) e depois tenta
// chegar até "Vendas 3.0 > Produção de Vendas" clicando pelo MENU de
// verdade (☰ > tile > link), não mais por navegação direta de URL.
//
// ⚠️ Atualizado em 2026-08-06 (sessão de descoberta ao vivo, ver
// scripts/x2-estoque-export.js pro relato completo): confirmado que o X2
// BLOQUEIA no servidor qualquer navegação direta por URL pra tela profunda
// ("Você não está autorizado a continuar. Acesso direto não permitido") —
// a versão anterior desta função que tentava `goto()` direto na
// POPUP_URL_MARK sempre ia falhar por causa disso, nunca era um problema
// de "aposta errada de URL". Cliques de MENU (☰, tiles, links de submenu)
// NÃO têm esse bloqueio — confirmados funcionando com clique automatizado
// na mesma sessão de descoberta. O que continua bloqueado — esse sim
// confirmado desde antes, é um mecanismo diferente (nível de JS da
// página) — é o clique ESPECÍFICO no botão "Catálogo de Produtos" dentro
// da tela de Produção de Vendas, que abre o popup em si. Então esta função
// agora chega pelo caminho certo (menu), mas o último clique (abrir o
// popup) ainda pode falhar como sempre falhou — o erro abaixo deixa claro
// qual é qual.
async function garantirPopupAberto(context, { confirmar, modoAutomatico } = {}) {
  let popup = context.pages().find((p) => p.url().includes(POPUP_URL_MARK));
  if (popup) return popup;

  const page = context.pages()[0] || (await context.newPage());
  if (!page.url().includes('xprocess.com.br')) {
    await page.goto(LOGIN_URL).catch(() => {});
  }

  if (modoAutomatico) {
    const pareceLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
    if (pareceLogin) {
      await tentarLoginAutomatico(page);
    }

    // ⚠️ Corrigido 2026-08-06 (2ª sessão de descoberta ao vivo, testando
    // x2-estoque-export.js): NÃO dar goto() direto pro index_main4.jsp
    // depois do login — mesma trava de "acesso direto não permitido" que já
    // bloqueava telas profundas também bloqueia essa URL quando é uma
    // navegação "fria" (sem vir de um clique/redirect de verdade),
    // confirmado ao vivo (apareceu "Gerenciamento de Acesso / Acesso
    // Negado!"). Por isso agora clica o menu direto de onde o login deixou
    // a página (o próprio X2 redireciona pra home depois do login).
    await page.waitForTimeout(500);
    // ☰ — primeiro link da página, confirmado ao vivo ser o ícone de menu
    // (ver x2-estoque-export.js pro mesmo padrão e a ressalva de fragilidade).
    await page.locator('a').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('a:has-text("Vendas 3.0")').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('a:has-text("Produção de Vendas")').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // A partir daqui é o clique JÁ documentado como bloqueado — tenta mesmo
    // assim (pode ter mudado, ou pode ser mais permissivo que o esperado),
    // mas sem surpresa se falhar.
    await page.evaluate(() => {
      const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
      const alvo = norm('Catálogo de Produtos');
      const frame = document.querySelector('iframe[name="principal"]');
      const doc = frame && frame.contentDocument ? frame.contentDocument : document;
      const els = Array.from(doc.querySelectorAll('button, a, input[type="button"]'));
      const el = els.find((e) => norm(e.textContent || e.value) === alvo);
      if (el) el.click();
    }).catch(() => {});
    await page.waitForTimeout(1500);

    popup = context.pages().find((p) => p.url().includes(POPUP_URL_MARK));
    if (!popup) {
      // Espera o clique humano em "Catálogo de Produtos" (esse clique bloqueia
      // automação). Um único clique vale pra rodada inteira.
      const esperaMin = Number(process.env.X2_ESPERA_CLIQUE_MIN) || 15;
      console.log(`⏳ Aguardando você clicar em "Catálogo de Produtos" na janela do Chrome (Vendas 3.0 > Produção de Vendas). Espero até ${esperaMin} min...`);
      const limite = Date.now() + esperaMin * 60 * 1000;
      while (!popup && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 2000));
        popup = context.pages().find((p) => p.url().includes(POPUP_URL_MARK));
      }
      if (!popup) {
        throw new Error(`Modo automático: esperei ${esperaMin} min e o popup "Catálogo de Produtos" não foi aberto (o clique nesse botão precisa ser humano). Rode de novo e clique quando a janela do Chrome estiver em "Vendas 3.0 > Produção de Vendas".`);
      }
      console.log('✅ Popup detectado, seguindo.');
    }
    await popup.waitForLoadState('domcontentloaded');
    await popup.waitForSelector('iframe[name="frame_pesquisa"]', { timeout: 15000 });
    return popup;
  }

  // Login automático também no modo manual (2026-08-06, pedido do usuário
  // depois de validar isso no script de estoque): se X2_USUARIO/X2_SENHA
  // estiverem no .env, tenta logar sozinho aqui também — sobra só o clique
  // no popup "Catálogo de Produtos" pro usuário, que é o único passo que
  // não dá pra automatizar (bloqueio de JS da própria página, ver aviso no
  // topo do arquivo). Se não tiver credenciais ou o login falhar por
  // qualquer motivo, cai pro fluxo 100% manual de sempre, sem travar.
  const pareceLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  let chegouNaTela = false;
  if (pareceLogin) {
    try {
      await tentarLoginAutomatico(page);
      console.log('Login automático ok.');
    } catch (e) {
      console.log(`(login automático não deu: ${e.message} — faça login manualmente)`);
    }
  }

  // Navegação também automática até a tela certa (2026-08-06, pedido do
  // usuário: "queria que fizesse aquele caminho, clicar vendas - catálogo
  // de produtos"). Cliques de MENU não têm o bloqueio — só o botão
  // "Catálogo de Produtos" em si tem. Então chega até a tela sozinho e
  // pausa só nesse último clique. Se algo aqui falhar (layout mudou, ainda
  // não logado etc.), cai pras instruções manuais de sempre sem travar.
  try {
    await page.waitForTimeout(500);
    await page.locator('a').first().click({ timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator('a:has-text("Vendas 3.0")').first().click({ timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator('a:has-text("Produção de Vendas")').first().click({ timeout: 8000 });
    await page.waitForTimeout(1000);
    chegouNaTela = true;
  } catch (e) {
    console.log(`(navegação automática até a tela não deu: ${e.message} — vá até lá manualmente)`);
  }

  console.log('\n==============================================================');
  if (chegouNaTela) {
    console.log('Já cheguei em Vendas 3.0 > Produção de Vendas. Só falta VOCÊ clicar no');
    console.log('botão "Catálogo de Produtos" — esse clique é bloqueado pro robô, precisa');
    console.log('ser um clique seu de verdade.');
  } else {
    console.log('Na janela do Chrome que abriu: faça login se precisar (a sessão fica');
    console.log('salva — nas próximas vezes já deve abrir logado).');
    console.log('Depois vá em: Vendas 3.0 > Produção de Vendas > botão "Catálogo de Produtos".');
    console.log('Esse clique precisa ser seu de verdade — o X2 bloqueia clique automatizado nesse botão específico.');
  }
  console.log('==============================================================\n');

  if (confirmar) {
    await confirmar('Abra o popup "Catálogo de Produtos" no X2 (Vendas 3.0 > Produção de Vendas) e clique em "Já cliquei, continuar" abaixo.');
  } else {
    await ask('Pressione Enter DEPOIS que o popup "Catálogo de Produtos" estiver aberto e a tela de busca visível... ');
  }

  popup = context.pages().find((p) => p.url().includes(POPUP_URL_MARK));
  if (!popup) {
    // dá mais um instante — às vezes o popup ainda está carregando quando o Enter é pressionado
    await new Promise((r) => setTimeout(r, 1500));
    popup = context.pages().find((p) => p.url().includes(POPUP_URL_MARK));
  }
  if (!popup) {
    throw new Error('Não encontrei o popup "Catálogo de Produtos" aberto. Confirme que ele abriu e rode o script de novo.');
  }
  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForSelector('iframe[name="frame_pesquisa"]', { timeout: 15000 });
  return popup;
}

// ─── Passos de busca/download (replicam exatamente a técnica validada ao
// vivo — ver memória "reference-x2-download-fotos-tecnica") ─────────────

async function buscarSecaoInteira(popup, labelSecao) {
  await popup.evaluate(({ labelAlvo }) => {
    function norm(s) {
      return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    }
    const fd = window.frames['frame_pesquisa'].document;
    fd.querySelector('input[name="id_produto"]').value = '';
    fd.querySelector('input[name="cd_fornecedor"]').value = '';
    fd.querySelector('input[name="cd_barras"]').value = '';
    fd.querySelector('input[name="ds_descricao_comercial"]').value = '';
    const sel = fd.querySelector('select[name="id_secao"]');
    const alvoNorm = norm(labelAlvo);
    const opt = Array.from(sel.options).find((o) => norm(o.textContent) === alvoNorm);
    if (!opt) throw new Error(`Seção "${labelAlvo}" não encontrada no dropdown do X2.`);
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    window.frames['frame_pesquisa'].pesquisar();
  }, { labelAlvo: labelSecao });

  // Polling EXTERNO (Playwright chamando de fora, não setTimeout dentro da
  // página) — funciona mesmo com a janela minimizada/em background.
  await popup.waitForFunction(
    () => window.frames['frame_pesquisa'].document.querySelectorAll('table a').length > 0,
    null,
    { timeout: 20000, polling: 400 }
  );
}

// Fallback (2026-10-01): produto que NÃO aparece na tabela da seção (ex.: recém-recebido,
// ou tabela da seção truncada) é procurado direto pelo código, com Seção = Todos.
async function buscarPorCodigoNoPopup(popup, codigo) {
  await popup.evaluate((cod) => {
    const fd = window.frames['frame_pesquisa'].document;
    for (const nome of ['cd_fornecedor', 'cd_barras', 'ds_descricao_comercial']) {
      const el = fd.querySelector(`input[name="${nome}"]`);
      if (el) el.value = '';
    }
    fd.querySelector('input[name="id_produto"]').value = cod;
    const sel = fd.querySelector('select[name="id_secao"]');
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    window.frames['frame_pesquisa'].pesquisar();
  }, codigo);
  try {
    await popup.waitForFunction(
      (cod) => Array.from(window.frames['frame_pesquisa'].document.querySelectorAll('table a'))
        .some((a) => a.textContent.trim().startsWith(cod + ' ')),
      codigo,
      { timeout: 12000, polling: 400 }
    );
    return true;
  } catch {
    return false;
  }
}

async function buscarEClicarProduto(popup, codigo) {
  return popup.evaluate((cod) => {
    const fpDoc = window.frames['frame_pesquisa'].document;
    const links = Array.from(fpDoc.querySelectorAll('table a'));
    const match = links.find((a) => a.textContent.trim().startsWith(cod + ' '));
    if (!match) return false;
    // Setar o src do iframe direto (não .click()) — ver motivo no cabeçalho do arquivo.
    document.querySelector('iframe[name="frame_foto"]').src = match.href;
    return true;
  }, codigo);
}

async function esperarFrameFoto(popup, codigo) {
  try {
    await popup.waitForFunction(
      (cod) => {
        const f = window.frames['frame_foto'];
        return !!(f && f.document && f.document.body && f.document.body.innerText.includes(cod));
      },
      codigo,
      { timeout: 15000, polling: 400 }
    );
    return true;
  } catch {
    return false;
  }
}

// Pedido do usuário (2026-08-05): "garanta que o programa não está deixando
// as fotos com baixa qualidade baixando em png" — o fetch abaixo SEMPRE
// salva os bytes EXATOS que o X2 devolveu pra aquele <img src>, sem passar
// por canvas nem reencode nenhum (readAsDataURL só serializa o blob já
// baixado) — então esse script nunca comprime nada por conta própria. O
// risco real que não dá pra descartar sem ver a tela ao vivo é outro: o X2
// poder estar servindo ali uma miniatura em vez da foto original. Como não
// tem como confirmar isso só lendo código, a saída é tornar o risco visível:
// grava a dimensão real e o tamanho em bytes de cada foto baixada, e avisa
// (sem bloquear) quando alguma vier menor que este limiar — não é corte
// automático porque uma buzina pode legitimamente ter uma foto menor que um
// farol, então cabe revisão manual dos códigos listados no aviso.
const LARGURA_MINIMA_AVISO = 400;

function fotosSuspeitas(detalhes) {
  return (detalhes || []).filter((d) => d.largura && d.largura < LARGURA_MINIMA_AVISO);
}

async function checarEBaixarFotos(popup, codigo, destDir) {
  const info = await popup.evaluate(() => {
    const ffd = window.frames['frame_foto'].document;
    const text = ffd.body.innerText;
    const temCarrossel = /Previous|Next/i.test(text);
    const imgs = Array.from(ffd.querySelectorAll('img')).filter((i) => i.naturalWidth > 60);
    return { temCarrossel, dims: imgs.map((i) => [i.naturalWidth, i.naturalHeight]) };
  });

  const ehPlaceholder =
    info.dims.length === 1 && info.dims[0][0] === 1200 && info.dims[0][1] === 1200 && !info.temCarrossel;

  if (!info.dims.length || ehPlaceholder) {
    return { status: ehPlaceholder ? 'placeholder' : 'sem_foto', arquivos: [] };
  }

  const arquivos = [];
  const detalhes = [];
  for (let idx = 0; idx < info.dims.length; idx++) {
    const dataUrl = await popup.evaluate(async (i) => {
      const ffw = window.frames['frame_foto'];
      const img = Array.from(ffw.document.querySelectorAll('img')).filter((el) => el.naturalWidth > 60)[i];
      const r = await ffw.fetch(img.src);
      const blob = await r.blob();
      return new Promise((resolve, reject) => {
        const reader = new ffw.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }, idx);

    const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(dataUrl || '');
    if (!m) continue;
    const mime = m[1];
    const buffer = Buffer.from(m[2], 'base64');
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
    const nomeArquivo = `${idx}.${ext}`;
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, nomeArquivo), buffer);
    arquivos.push(nomeArquivo);
    const [largura, altura] = info.dims[idx] || [];
    detalhes.push({ arquivo: nomeArquivo, largura: largura || null, altura: altura || null, bytes: buffer.length });
  }
  return { status: arquivos.length ? 'ok' : 'sem_foto', arquivos, detalhes };
}

async function processarUmProduto(popup, codigo, secaoSlug) {
  let achou = await buscarEClicarProduto(popup, codigo);
  let usouFallback = false;
  if (!achou) {
    // Fallback: busca direta pelo código (Seção = Todos) e, depois, restaura a tabela da seção.
    usouFallback = await buscarPorCodigoNoPopup(popup, codigo);
    if (usouFallback) achou = await buscarEClicarProduto(popup, codigo);
  }
  try {
    if (!achou) return { status: 'nao_encontrado_na_tabela', arquivos: [] };
    return await _baixarProdutoAberto(popup, codigo, secaoSlug);
  } finally {
    if (usouFallback) {
      try { await buscarSecaoInteira(popup, SECOES[secaoSlug]); } catch { /* o próximo item acusa erro se não restaurou */ }
    }
  }
}

async function _baixarProdutoAberto(popup, codigo, secaoSlug) {

  const bateu = await esperarFrameFoto(popup, codigo);
  if (!bateu) return { status: 'frame_foto_nao_bateu', arquivos: [] };

  // Pequena margem — mesmo cuidado documentado na memória (naturalWidth
  // ocasionalmente ainda não resolveu no instante em que o texto já bateu).
  await popup.waitForTimeout(400);

  const destDir = path.join(stagingSecaoDir(secaoSlug), codigo);
  return checarEBaixarFotos(popup, codigo, destDir);
}

// ─── Orquestração ───────────────────────────────────────────────────────

// Decide quais códigos entram na fila desta execução. Separado em função
// pura (sem navegador/fs) pra ser testável isoladamente.
//
// PEDIDO DO USUÁRIO (2026-07-28): "se futuramente surgir produtos sem
// fotos, conseguimos ir atualizando por lá?" — pra produtos que JÁ estão
// no nosso catálogo (JSON) mas ficaram marcados "sem_foto"/"placeholder"
// (o X2 não tinha foto na época), a opção `retrySemFoto` faz o script
// tentar essas de novo, caso o X2 tenha cadastrado a foto depois. Não
// cobre produto totalmente NOVO (código que ainda nem existe no JSON da
// seção) — isso precisaria antes de uma nova extração em massa (tela
// compra/catalogo_produto) pra descobrir o código novo.
//
// `codigosEspecificos` (pedido do usuário, 2026-09-11): quando informado,
// restringe a fila a SÓ esses códigos antes de aplicar a lógica de
// pendente/retry acima — usado pelo encadeamento pós-Lançamentos (ver
// server.js), pra baixar foto só dos códigos que tiveram lançamento
// naquela semana, sem puxar de brinde o resto do backlog pendente da
// mesma seção. `codigos` continua sendo TODOS os códigos da seção (lidos
// do <slug>.json em processarSecaoComPopup) — o filtro é sempre uma
// interseção com esse total, nunca uma lista solta por fora dele.
function calcularFila(codigos, progresso, { limit, retrySemFoto, codigosEspecificos, renovarAposDias, renovarLimite } = {}) {
  const base = codigosEspecificos && codigosEspecificos.length
    ? codigos.filter((c) => codigosEspecificos.includes(String(c)))
    : codigos;
  const pendentes = base.filter((c) => {
    if (!progresso[c]) return true;
    // Rodada restrita a códigos (Lançamentos): o que não foi achado/baixado antes entra de novo
    // (produto recém-recebido pode demorar a aparecer na tela Catálogo de Produtos do X2).
    if (codigosEspecificos && codigosEspecificos.length && ['nao_encontrado_na_tabela', 'frame_foto_nao_bateu', 'erro'].includes(progresso[c].status)) return true;
    // BUG REAL corrigido (2026-08-13, achado analisando os 1209 erros de
    // MECÂNICA — provável degradação de uma sessão de navegador longa
    // demais, ver comentário em rodarMuitasSecoes): produto com
    // status:"erro" ficava preso PRA SEMPRE — só "sem_foto"/"placeholder"
    // entravam de novo na fila com retrySemFoto, nunca "erro". A única
    // forma de tentar de novo era "Reiniciar do zero", que apaga TODO o
    // progresso da seção (inclusive as fotos boas já baixadas) só pra
    // reprocessar um punhado de erros. Agora "erro" entra no mesmo retry.
    if (retrySemFoto && (progresso[c].status === 'sem_foto' || progresso[c].status === 'placeholder' || progresso[c].status === 'erro')) return true;
    // BUG REAL corrigido (2026-10-31, achado analisando os checkpoints de
    // instrumento-painel/gerador/consumo — 88%/98%/97% travados aqui):
    // "nao_encontrado_na_tabela" (código não apareceu na tabela de
    // resultado da seção nem via fallback por código) NUNCA voltava à
    // fila numa rodada normal de --retry-sem-foto — só voltava no fluxo
    // restrito a codigosEspecificos (pós-Lançamentos, linha acima). Pro
    // usuário rodar a recaptura manual de uma seção inteira e de fato
    // reprocessar esse backlog (em vez de "Nada pendente nesta seção"
    // mesmo com milhares faltando), esse status entra no mesmo retry
    // geral — junto com "frame_foto_nao_bateu" (também só retryable antes
    // via codigosEspecificos), que é tipicamente um soluço de timing, não
    // um "sem foto" permanente.
    if (retrySemFoto && (progresso[c].status === 'nao_encontrado_na_tabela' || progresso[c].status === 'frame_foto_nao_bateu')) return true;
    return false;
  });
  // Renovação de fotos (auditoria 2026-09-30): "ok" nunca voltava à fila, então
  // foto trocada no X2 jamais era rebaixada. Com renovarAposDias, entram também
  // os códigos "ok" cujo download é mais velho que N dias — os mais antigos
  // primeiro, no máximo `renovarLimite` (padrão 300) por execução, pra girar o
  // catálogo aos poucos sem uma rodada de horas.
  if (renovarAposDias && renovarAposDias > 0) {
    const corte = Date.now() - renovarAposDias * 86400000;
    const idade = (c) => { const t = Date.parse(progresso[c] && progresso[c].ts); return Number.isFinite(t) ? t : 0; };
    const velhos = base
      .filter((c) => progresso[c] && progresso[c].status === 'ok' && idade(c) < corte)
      .sort((a, b) => idade(a) - idade(b))
      .slice(0, renovarLimite || 300);
    pendentes.push(...velhos);
  }
  return limit ? pendentes.slice(0, limit) : pendentes;
}

// Processa UMA seção usando um popup já aberto (não abre/fecha navegador —
// isso permite encadear várias seções numa única sessão de navegador/login,
// ver `rodarMuitasSecoes`).
async function processarSecaoComPopup(popup, secaoSlug, { limit, retrySemFoto, deveParar, codigosEspecificos, renovarAposDias, renovarLimite } = {}) {
  const labelSecao = SECOES[secaoSlug];
  if (!labelSecao) {
    throw new Error(`Seção desconhecida: "${secaoSlug}". Opções: ${Object.keys(SECOES).join(', ')}`);
  }

  const jsonPath = path.join(CATALOGO_DIR, `${secaoSlug}.json`);
  const produtos = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const codigos = produtos.map((p) => p.codigo);

  const progresso = carregarProgresso(secaoSlug);
  const fila = calcularFila(codigos, progresso, { limit, retrySemFoto, codigosEspecificos, renovarAposDias, renovarLimite });

  console.log(`\n=== Seção ${labelSecao} (${secaoSlug}) ===`);
  console.log(`${codigos.length} produtos no total, ${Object.keys(progresso).length} já processados, ${fila.length} nesta execução${retrySemFoto ? ' (incluindo retry de sem_foto/placeholder/erro/nao_encontrado/frame_foto_nao_bateu)' : ''}${codigosEspecificos && codigosEspecificos.length ? ` (restrito aos ${codigosEspecificos.length} código(s) informado(s))` : ''}.`);
  if (!fila.length) {
    console.log('Nada pendente nesta seção.');
    return { secaoSlug, totalFeitos: Object.keys(progresso).length, total: codigos.length, pulada: true };
  }

  console.log('Selecionando a seção e buscando todos os produtos de uma vez...');
  await buscarSecaoInteira(popup, labelSecao);
  console.log('Busca feita. Processando produto por produto...\n');

  let ok = 0, placeholder = 0, semFoto = 0, erro = 0, pequenas = 0;
  const codigosComFotoPequena = [];
  for (const codigo of fila) {
    // BUG REAL corrigido (2026-08-13, usuário relatou "mesmo com Cancelado
    // ainda está baixando fotos"): antes, cancelar só destravava a UI
    // (`execucao.rodando = false` em server.js) sem nunca checar dentro
    // DESTE loop — a seção inteira (até 1751 produtos numa sessão real)
    // continuava sendo processada sozinha em segundo plano, só que o
    // painel dizia "Cancelado". `deveParar()` (passado por rodarAcao em
    // server.js, liga com o botão Cancelar/destravar) é checado a cada
    // item — o loop para de verdade em poucos segundos, não minutos.
    // Seguro porque o progresso já é salvo item a item (comentário abaixo).
    if (deveParar && deveParar()) {
      const feito = ok + placeholder + semFoto + erro;
      console.log(`\n\n⏹ Cancelado pelo usuário — parando em ${feito}/${fila.length} itens desta seção (progresso já salvo, pode continuar de onde parou rodando de novo).`);
      break;
    }
    let resultado;
    try {
      resultado = await processarUmProduto(popup, codigo, secaoSlug);
    } catch (e) {
      resultado = { status: 'erro', mensagem: e.message, arquivos: [] };
    }
    progresso[codigo] = { ...resultado, ts: new Date().toISOString() };
    salvarProgresso(secaoSlug, progresso); // salva a CADA item — seguro contra Ctrl+C

    if (resultado.status === 'ok') {
      ok++;
      if (fotosSuspeitas(resultado.detalhes).length) {
        pequenas++;
        codigosComFotoPequena.push(codigo);
      }
    }
    else if (resultado.status === 'placeholder') placeholder++;
    else if (resultado.status === 'sem_foto') semFoto++;
    else erro++;

    const feito = ok + placeholder + semFoto + erro;
    process.stdout.write(
      `\r[${feito}/${fila.length}] ${codigo} -> ${resultado.status.padEnd(22)} | ok:${ok} placeholder:${placeholder} sem_foto:${semFoto} erro:${erro} pequena:${pequenas}    `
    );
  }
  console.log('\n\nLote concluído.');

  // Pedido do usuário (2026-08-05): lista explícita dos códigos com foto
  // abaixo do limiar — pra conferência manual pontual em vez de confiar cego
  // no processo (ver LARGURA_MINIMA_AVISO acima).
  if (codigosComFotoPequena.length) {
    console.log(`\n⚠ ${codigosComFotoPequena.length} produto(s) com foto abaixo de ${LARGURA_MINIMA_AVISO}px de largura (pode ser miniatura em vez da foto original — vale conferir no X2):`);
    console.log(codigosComFotoPequena.map((c) => `  - ${c}`).join('\n'));
  }

  const totalFeitos = Object.keys(progresso).length;
  console.log(`Progresso total da seção: ${totalFeitos}/${codigos.length}.`);
  if (totalFeitos >= codigos.length) {
    console.log(`Seção COMPLETA! Rode com --secao=${secaoSlug} --build-zip (sozinho, fora do modo --todas) pra montar o zip.`);
  } else {
    console.log(`Faltam ${codigos.length - totalFeitos}. Rode de novo (mesmo comando) pra continuar de onde parou.`);
  }
  return { secaoSlug, totalFeitos, total: codigos.length, pulada: false };
}

async function rodarSecao(secaoSlug, { limit, channel, retrySemFoto, reiniciar, confirmar, modoAutomatico, deveParar, codigosEspecificos, renovarAposDias, renovarLimite }) {
  if (reiniciar) {
    console.log(`Reiniciando "${secaoSlug}" do zero (apagando progresso e staging salvos)...`);
    reiniciarSecao(secaoSlug);
  }
  const context = await abrirNavegador(channel);
  try {
    const popup = await garantirPopupAberto(context, { confirmar, modoAutomatico });
    await processarSecaoComPopup(popup, secaoSlug, { limit, retrySemFoto, deveParar, codigosEspecificos, renovarAposDias, renovarLimite });
  } finally {
    await context.close().catch(() => {});
  }
}

// Roda várias seções em UMA ÚNICA sessão de navegador — só pausa 1x pro
// usuário logar/abrir o popup, depois processa seção por seção sozinho.
// `limit`, se passado, se aplica a CADA seção (não ao total).
async function rodarMuitasSecoes(slugs, { limit, channel, retrySemFoto, reiniciar, confirmar, modoAutomatico, deveParar, codigosEspecificos, renovarAposDias, renovarLimite }) {
  if (reiniciar) {
    console.log(`Reiniciando ${slugs.length} seção(ões) do zero (apagando progresso e staging salvos)...`);
    for (const s of slugs) reiniciarSecao(s);
  }
  const context = await abrirNavegador(channel);
  const resumo = [];
  try {
    const popup = await garantirPopupAberto(context, { confirmar, modoAutomatico });
    for (const secaoSlug of slugs) {
      // Mesmo `deveParar()` do comentário em processarSecaoComPopup — checa
      // ENTRE seções também, pra não nem começar a próxima se o usuário já
      // cancelou enquanto a anterior tava concluindo.
      if (deveParar && deveParar()) {
        console.log(`\n⏹ Cancelado pelo usuário — parando antes de "${secaoSlug}" (${slugs.length - resumo.length} seção(ões) não processada(s) nesta rodada).`);
        break;
      }
      try {
        // `codigosEspecificos` (pedido do usuário, 2026-09-11) se aplica a
        // TODAS as seções da lista igual — cada `processarSecaoComPopup`
        // faz a interseção com os códigos da SUA própria seção (ver
        // calcularFila), então passar a mesma lista pra todas aqui é seguro
        // mesmo com seções diferentes na mesma chamada.
        const r = await processarSecaoComPopup(popup, secaoSlug, { limit, retrySemFoto, deveParar, codigosEspecificos, renovarAposDias, renovarLimite });
        resumo.push(r);
      } catch (e) {
        console.error(`\nErro na seção ${secaoSlug}: ${e.message} — pulando pra próxima.`);
        resumo.push({ secaoSlug, erro: e.message });
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  console.log('\n\n=== Resumo geral ===');
  for (const r of resumo) {
    if (r.erro) {
      console.log(`${r.secaoSlug}: ERRO — ${r.erro}`);
    } else if (r.pulada) {
      console.log(`${r.secaoSlug}: nada pendente (${r.totalFeitos}/${r.total})`);
    } else {
      const completo = r.totalFeitos >= r.total;
      console.log(`${r.secaoSlug}: ${r.totalFeitos}/${r.total}${completo ? ' — COMPLETA, pronta pro --build-zip' : ''}`);
    }
  }
}

// PEDIDO DO USUÁRIO (2026-08-12): "seria algum ganho [recarregar o catálogo
// do painel de atendimento sem reiniciar o bot]?" — mesmo padrão de
// _forcarReloadCacheEstoque() em x2-estoque-export.js e
// _forcarReloadCatalogo() em x2-catalogo-sync.js (Bearer API_TOKEN,
// best-effort — se falhar, o zip já foi gravado em disco corretamente, só o
// painel de atendimento continua com o índice de fotos velho até reiniciar;
// não é motivo pra derrubar o script). Chama o endpoint
// POST /api/catalogo/produtos/recarregar (ver catalogo.controller.js) —
// mesma rota usada por x2-catalogo-sync.js, recarrega produtos E fotos numa
// chamada só, então não tem problema chamar dos dois lugares.
async function _forcarReloadCatalogo() {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken === 'troque_por_um_token_com_64_caracteres_ou_mais') {
    console.log('(API_TOKEN não configurado no .env — não deu pra recarregar o catálogo do painel de atendimento na hora; precisa reiniciar o bot Rildon pra essas fotos aparecerem na busca.)');
    return;
  }
  try {
    const { BASE_URL } = require('./x2-whatsapp-alerta');
    const resposta = await fetch(`${BASE_URL}/api/catalogo/produtos/recarregar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      console.log(`(reload do catálogo recusado pelo bot Rildon: HTTP ${resposta.status} — ${corpo.error || 'sem detalhe'}. Reinicie o bot pra essas fotos aparecerem na busca.)`);
      return;
    }
    console.log('Catálogo do painel de atendimento recarregado na hora — não precisa reiniciar o bot.');
  } catch (e) {
    console.log(`(não consegui chamar o bot Rildon pra recarregar o catálogo: ${e.message}. Reinicie o bot pra essas fotos aparecerem na busca.)`);
  }
}

// Retenção de backups (auditoria 2026-09-30): .zip.bak-* acumulavam ~20 GB.
// OPT-IN: só poda se X2_ZIP_BACKUPS_MANTER for definido (ex: 20). Sem a variável,
// nada é apagado (decisão do usuário: risco de perder foto que só existe no backup).
// Nunca apaga o backup mais recente com conteúdo real (> 1 KB).
function podarBackupsZip(secaoSlug, manter = Number(process.env.X2_ZIP_BACKUPS_MANTER) || 0) {
  if (!manter) return;
  try {
    const prefixo = `${secaoSlug}.zip.bak-`;
    const baks = fs.readdirSync(FOTOS_DIR)
      .filter((n) => n.startsWith(prefixo))
      .map((n) => ({ n, ts: Number(n.slice(prefixo.length)) || 0, size: fs.statSync(path.join(FOTOS_DIR, n)).size }))
      .sort((a, b) => b.ts - a.ts);
    const ultimoBom = baks.find((b) => b.size > 1024);
    let removidos = 0;
    for (const b of baks.slice(manter)) {
      if (ultimoBom && b.n === ultimoBom.n) continue;
      fs.unlinkSync(path.join(FOTOS_DIR, b.n));
      removidos++;
    }
    if (removidos) console.log(`Backups antigos de ${secaoSlug}: ${removidos} removido(s), mantendo os ${manter} mais recentes.`);
  } catch (e) {
    console.log(`(não consegui podar backups de ${secaoSlug}: ${e.message})`);
  }
}

async function montarZipFinal(secaoSlug, { parcial = false } = {}) {
  const labelSecao = SECOES[secaoSlug];
  if (!labelSecao) {
    throw new Error(`Seção desconhecida: "${secaoSlug}". Opções: ${Object.keys(SECOES).join(', ')}`);
  }

  const jsonPath = path.join(CATALOGO_DIR, `${secaoSlug}.json`);
  const produtos = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const codigos = produtos.map((p) => p.codigo);
  const progresso = carregarProgresso(secaoSlug);

  const faltando = codigos.filter((c) => !progresso[c]);
  if (faltando.length && !parcial) {
    console.log(`ATENÇÃO: ${faltando.length} de ${codigos.length} produtos ainda não foram processados nesta seção.`);
    console.log('O zip só é montado quando a seção estiver 100% processada — rode sem --build-zip pra continuar.');
    return;
  }
  if (faltando.length) {
    console.log(`(zip parcial de "${secaoSlug}": ${faltando.length} produto(s) ainda sem download — as fotos que já estão no zip atual são preservadas.)`);
  }

  const stagingDir = stagingSecaoDir(secaoSlug);
  const destino = path.join(FOTOS_DIR, `${secaoSlug}.zip`);

  // BUG REAL corrigido (2026-08-31, achado investigando produtos "com todas
  // as fotos baixadas" mas sem foto no Catálogo — ex: DNI0102/102670, ver
  // memória "bot Rildon: fotos invisíveis..."): este loop reconstruía o zip
  // INTEIRO do zero a cada rodada, só a partir do `progresso` ATUAL. Um
  // código que já tinha foto real num zip anterior (status:"ok" numa rodada
  // passada) mas que — por qualquer motivo (degradação de sessão do
  // navegador, "Reiniciar do zero" parcial, etc., ver comentário em
  // calcularFila) — ficou marcado "erro"/"sem_foto"/"placeholder" na rodada
  // atual, tinha sua foto REAL simplesmente descartada aqui, e o zip novo
  // (sem essa foto) sobrescrevia o zip antigo (que a tinha). O backup
  // automático (`.zip.bak-*` logo abaixo) evitou perda definitiva, mas o
  // Catálogo ao vivo ficava sem a foto até alguém notar e restaurar na mão.
  // Fix: antes de descartar um código não-"ok", olha se ele já tem foto(s)
  // no zip EXISTENTE em disco — se tiver, preserva essas fotos no zip novo
  // em vez de descartar. Só produtos que NUNCA tiveram foto real registrada
  // em nenhuma rodada (não estão no zip antigo) continuam de fato de fora.
  const existentesPorCodigo = new Map();
  if (fs.existsSync(destino)) {
    try {
      const entradasExistentes = listarEntradasZip(destino);
      for (const entrada of entradasExistentes) {
        const barra = entrada.name.indexOf('/');
        if (barra <= 0) continue;
        const codigo = entrada.name.slice(0, barra);
        if (!existentesPorCodigo.has(codigo)) existentesPorCodigo.set(codigo, []);
        existentesPorCodigo.get(codigo).push(entrada);
      }
    } catch (e) {
      console.log(`(não consegui ler o zip anterior pra preservar fotos já existentes: ${e.message} — seguindo sem preservação.)`);
    }
  }

  const entradas = [];
  let semFotoCount = 0, placeholderCount = 0, erroCount = 0, preservadoCount = 0;
  const pequenasCodigos = [];
  const preservadosCodigos = [];
  const comFotoReal = new Set();

  for (const codigo of codigos) {
    const st = progresso[codigo];
    if (!st) {
      // Ainda não processado (só ocorre em zip parcial): preserva o que o zip atual já tem.
      const preservar = existentesPorCodigo.get(codigo);
      if (preservar && preservar.length) {
        for (const entrada of preservar) entradas.push({ name: entrada.name, data: extrairArquivoZip(destino, entrada) });
      }
      continue;
    }
    if (st.status !== 'ok') {
      if (st.status === 'sem_foto') semFotoCount++;
      else if (st.status === 'placeholder') placeholderCount++;
      else erroCount++;

      const preservar = existentesPorCodigo.get(codigo);
      if (preservar && preservar.length) {
        preservadoCount++;
        preservadosCodigos.push(codigo);
        comFotoReal.add(codigo);
        for (const entrada of preservar) {
          entradas.push({ name: entrada.name, data: extrairArquivoZip(destino, entrada) });
        }
      }
      continue;
    }
    comFotoReal.add(codigo);
    if (fotosSuspeitas(st.detalhes).length) pequenasCodigos.push(codigo);
    const dir = path.join(stagingDir, codigo);
    const arquivos = (st.arquivos && st.arquivos.length) ? st.arquivos : (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    // Progresso semeado do zip (x2-semear-progresso.js) ou staging apagado:
    // se algum arquivo não está em disco, usa as fotos do zip existente.
    const faltaArquivo = arquivos.some((nome) => !fs.existsSync(path.join(dir, nome)));
    const doZip = existentesPorCodigo.get(codigo);
    if (faltaArquivo && doZip && doZip.length) {
      for (const entrada of doZip) entradas.push({ name: entrada.name, data: extrairArquivoZip(destino, entrada) });
      continue;
    }
    for (const nome of arquivos) {
      const data = fs.readFileSync(path.join(dir, nome));
      entradas.push({ name: `${codigo}/${nome}`, data });
    }
  }

  // TRAVA (auditoria 2026-09-30): instrumento-painel.zip foi sobrescrito por
  // um zip VAZIO (22 bytes) e ~343 fotos sumiram do Catálogo ao vivo. Recusa
  // sobrescrever se o zip novo tem 0 fotos, ou perde mais de 30% das fotos
  // do zip atual (--forcar-zip ou X2_FORCAR_ZIP=1 confirma que é intencional).
  // Só conta fotos de códigos que ainda pertencem à seção (código que saiu do JSON não conta como "perda").
  const fotosAnteriores = codigos.reduce((a, c) => a + ((existentesPorCodigo.get(c) || []).length), 0);
  const forcarZip = process.argv.includes('--forcar-zip') || process.env.X2_FORCAR_ZIP === '1';
  if (!forcarZip) {
    if (entradas.length === 0) {
      throw new Error(`Zip de "${secaoSlug}" NÃO gerado: o novo teria 0 fotos (o atual tem ${fotosAnteriores}). Zip antigo mantido. Confira o staging/progresso da seção.`);
    }
    if (fotosAnteriores > 0 && entradas.length < fotosAnteriores * 0.7) {
      throw new Error(`Zip de "${secaoSlug}" NÃO gerado: o novo teria ${entradas.length} fotos contra ${fotosAnteriores} do atual (queda maior que 30%). Zip antigo mantido. Use --forcar-zip se for intencional.`);
    }
  }

  const zipBuf = criarZip(entradas);
  fs.mkdirSync(FOTOS_DIR, { recursive: true });
  if (fs.existsSync(destino)) {
    const backup = path.join(FOTOS_DIR, `${secaoSlug}.zip.bak-${Date.now()}`);
    fs.copyFileSync(destino, backup);
    console.log(`Backup do zip antigo: ${backup}`);
  }
  // Escrita atômica: grava em .tmp e renomeia, nunca deixa zip pela metade.
  const tmpZip = `${destino}.tmp-${process.pid}`;
  fs.writeFileSync(tmpZip, zipBuf);
  fs.renameSync(tmpZip, destino);
  podarBackupsZip(secaoSlug);
  await _forcarReloadCatalogo();

  console.log(`\nZip final gerado: ${destino}`);
  console.log(`${entradas.length} fotos, de ${comFotoReal.size} produtos com foto real.`);
  console.log(`${semFotoCount} sem foto cadastrada no X2, ${placeholderCount} só com o placeholder "imagem não disponível", ${erroCount} com erro (revise manualmente).`);
  if (preservadoCount) {
    console.log(`${preservadoCount} produto(s) preservado(s) do zip anterior (status atual não é "ok", mas já tinham foto real de uma rodada passada): ${preservadosCodigos.join(', ')}`);
  }
  console.log(`${pequenasCodigos.length} produto(s) com foto abaixo de ${LARGURA_MINIMA_AVISO}px — revisar: ${pequenasCodigos.join(', ') || '(nenhum)'}`);
  console.log(`\nFalta atualizar a linha "${labelSecao}" na tabela de src/config/catalogo-x2/README.md com a nova contagem/data.`);
}

// Pedido do usuário (2026-07-30): "pode salvar todas normalmente" — em vez
// de compactar num .zip, copia as fotos soltas (uma arquivo por foto,
// exatamente no formato original baixado — sem recompressão nenhuma) pra
// dentro do projeto. Mesma regra de segurança do .zip: só escreve no
// OneDrive numa passada só, DEPOIS que a seção inteira já foi baixada pro
// staging (fora do OneDrive) — nunca escreve foto por foto direto na pasta
// do projeto durante o scraping em si (ver comentário no topo do arquivo
// sobre por que o staging fica fora do OneDrive).
async function exportarFotosSoltas(secaoSlug) {
  const labelSecao = SECOES[secaoSlug];
  if (!labelSecao) {
    throw new Error(`Seção desconhecida: "${secaoSlug}". Opções: ${Object.keys(SECOES).join(', ')}`);
  }

  const jsonPath = path.join(CATALOGO_DIR, `${secaoSlug}.json`);
  const produtos = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const codigos = produtos.map((p) => p.codigo);
  const progresso = carregarProgresso(secaoSlug);

  const faltando = codigos.filter((c) => !progresso[c]);
  if (faltando.length) {
    console.log(`ATENÇÃO: ${faltando.length} de ${codigos.length} produtos ainda não foram processados nesta seção.`);
    console.log('A exportação só roda quando a seção estiver 100% processada — rode sem --exportar-fotos pra continuar.');
    return;
  }

  const stagingDir = stagingSecaoDir(secaoSlug);
  const destDir = path.join(FOTOS_DIR, secaoSlug);
  let copiadas = 0, semFotoCount = 0, placeholderCount = 0, erroCount = 0;
  const pequenasCodigos = [];

  for (const codigo of codigos) {
    const st = progresso[codigo];
    if (st.status === 'sem_foto') { semFotoCount++; continue; }
    if (st.status === 'placeholder') { placeholderCount++; continue; }
    if (st.status !== 'ok') { erroCount++; continue; }
    if (fotosSuspeitas(st.detalhes).length) pequenasCodigos.push(codigo);
    const dirOrigem = path.join(stagingDir, codigo);
    const arquivos = (st.arquivos && st.arquivos.length) ? st.arquivos : (fs.existsSync(dirOrigem) ? fs.readdirSync(dirOrigem) : []);
    if (!arquivos.length) continue;
    const dirDestino = path.join(destDir, codigo);
    fs.mkdirSync(dirDestino, { recursive: true });
    for (const nome of arquivos) {
      fs.copyFileSync(path.join(dirOrigem, nome), path.join(dirDestino, nome));
      copiadas++;
    }
  }

  console.log(`\nFotos exportadas para: ${destDir}`);
  console.log(`${copiadas} fotos, de ${codigos.length - semFotoCount - placeholderCount - erroCount} produtos com foto real.`);
  console.log(`${semFotoCount} sem foto cadastrada no X2, ${placeholderCount} só com o placeholder "imagem não disponível", ${erroCount} com erro (revise manualmente).`);
  console.log(`${pequenasCodigos.length} produto(s) com foto abaixo de ${LARGURA_MINIMA_AVISO}px — revisar: ${pequenasCodigos.join(', ') || '(nenhum)'}`);
}

// Conta arquivos DE VERDADE em disco (não só o que o checkpoint de progresso
// diz que baixou) — prova concreta de que as fotos existem fisicamente.
function contarArquivosReais(secaoSlug) {
  const dir = stagingSecaoDir(secaoSlug);
  if (!fs.existsSync(dir)) return { produtosComPasta: 0, arquivos: 0 };
  const produtoDirs = fs.readdirSync(dir);
  let arquivos = 0;
  for (const codigo of produtoDirs) {
    const p = path.join(dir, codigo);
    if (fs.statSync(p).isDirectory()) arquivos += fs.readdirSync(p).length;
  }
  return { produtosComPasta: produtoDirs.length, arquivos };
}

function mostrarStatus(slugsFiltro) {
  const slugs = slugsFiltro && slugsFiltro.length ? slugsFiltro : Object.keys(SECOES);
  console.log(`\nArquivos em disco: ${WORK_DIR}\n`);
  console.log('Seção'.padEnd(34), 'Progresso'.padEnd(18), 'Arquivos reais em disco');
  console.log('-'.repeat(80));
  for (const slug of slugs) {
    const label = SECOES[slug];
    if (!label) { console.log(`${slug}: seção desconhecida`); continue; }
    let total = 0;
    try {
      total = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8')).length;
    } catch { /* json não encontrado */ }
    const progresso = carregarProgresso(slug);
    const feitos = Object.keys(progresso).length;
    const { produtosComPasta, arquivos } = contarArquivosReais(slug);
    console.log(
      `${label} (${slug})`.padEnd(34),
      `${feitos}/${total || '?'}`.padEnd(18),
      `${arquivos} fotos em ${produtosComPasta} pastas de produto`
    );
  }
  console.log(`\n(Fotos ficam em ${STAGING_DIR}\\<secao>\\<codigo>\\ até o --build-zip juntar tudo no .zip final.)`);
}

async function main() {
  const args = process.argv.slice(2);
  const secaoArg = args.find((a) => a.startsWith('--secao='));
  const secoesArg = args.find((a) => a.startsWith('--secoes='));
  const todas = args.includes('--todas');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const channelArg = args.find((a) => a.startsWith('--channel='));
  const buildZip = args.includes('--build-zip');
  const exportarFotos = args.includes('--exportar-fotos');
  const status = args.includes('--status');
  const retrySemFoto = args.includes('--retry-sem-foto');
  const reiniciar = args.includes('--reiniciar');

  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  const channel = channelArg ? channelArg.split('=')[1] : 'chrome';

  if (status) {
    const slugsFiltro = secaoArg ? [secaoArg.split('=')[1]] : secoesArg ? secoesArg.split('=')[1].split(',').map((s) => s.trim()) : null;
    mostrarStatus(slugsFiltro);
    return;
  }

  if (!secaoArg && !secoesArg && !todas) {
    console.log('Uso:');
    console.log('  node scripts/x2-fotos-scraper.js --secao=<slug> [--limit=N] [--build-zip] [--channel=chrome|msedge]');
    console.log('  node scripts/x2-fotos-scraper.js --secoes=<slug1>,<slug2>,... [--limit=N]   (várias seções, 1 login só)');
    console.log('  node scripts/x2-fotos-scraper.js --todas [--limit=N]                          (todas as 26 seções, 1 login só)');
    console.log('  node scripts/x2-fotos-scraper.js --status [--secao=<slug>]                    (confere o que já foi baixado de verdade em disco)');
    console.log('  ... adicione --retry-sem-foto em qualquer um dos modos acima pra tentar de novo');
    console.log('      os produtos já conhecidos que ficaram marcados sem_foto/placeholder (caso o');
    console.log('      X2 tenha cadastrado a foto depois). Não descobre produto NOVO no X2.');
    console.log('  ... adicione --reiniciar em qualquer um dos modos acima pra apagar o progresso');
    console.log('      salvo e baixar TUDO de novo do zero (ignora o que já tinha sido feito).');
    console.log('  node scripts/x2-fotos-scraper.js --secao=<slug> --exportar-fotos             (seção 100% processada → copia as fotos soltas, sem zip, pra src/config/catalogo-x2/fotos/<slug>/)');
    console.log('\nSeções disponíveis:');
    console.log(Object.keys(SECOES).map((s) => `  ${s}`).join('\n'));
    process.exit(1);
  }

  if (buildZip) {
    if (!secaoArg) {
      console.log('--build-zip precisa de --secao=<slug> específico (monta uma seção por vez, de propósito).');
      process.exit(1);
    }
    await montarZipFinal(secaoArg.split('=')[1]);
    return;
  }

  if (exportarFotos) {
    if (!secaoArg) {
      console.log('--exportar-fotos precisa de --secao=<slug> específico (exporta uma seção por vez, de propósito).');
      process.exit(1);
    }
    await exportarFotosSoltas(secaoArg.split('=')[1]);
    return;
  }

  if (todas) {
    await rodarMuitasSecoes(Object.keys(SECOES), { limit, channel, retrySemFoto, reiniciar });
    return;
  }

  if (secoesArg) {
    const slugs = secoesArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
    const desconhecidos = slugs.filter((s) => !SECOES[s]);
    if (desconhecidos.length) {
      throw new Error(`Seção(ões) desconhecida(s): ${desconhecidos.join(', ')}. Opções: ${Object.keys(SECOES).join(', ')}`);
    }
    await rodarMuitasSecoes(slugs, { limit, channel, retrySemFoto, reiniciar });
    return;
  }

  await rodarSecao(secaoArg.split('=')[1], { limit, channel, retrySemFoto, reiniciar });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  SECOES,
  normalizar,
  progressPath,
  carregarProgresso,
  salvarProgresso,
  stagingSecaoDir,
  WORK_DIR,
  CATALOGO_DIR,
  calcularFila,
  reiniciarSecao,
  exportarFotosSoltas,
  rodarSecao,
  rodarMuitasSecoes,
  montarZipFinal,
  LARGURA_MINIMA_AVISO,
  fotosSuspeitas,
  tentarLoginAutomatico,
  esconderWebdriver,
};
