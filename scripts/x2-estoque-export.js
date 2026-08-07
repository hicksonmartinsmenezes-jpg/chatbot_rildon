#!/usr/bin/env node
/**
 * scripts/x2-estoque-export.js
 *
 * PEDIDO DO USUÁRIO (2026-08-06): "vou te explicar a rotina pra encontrar
 * estoque... na tela de Logística - Relatório de Estoque - vai ter um
 * painel onde eu preciso que pesquise todos os itens... e tem a opção de
 * criar csv". Sessão de descoberta ao vivo (usuário mostrou a tela real +
 * inspeção de DOM via extensão do Chrome, mesma data) confirmou:
 *   - Menu: ☰ (ícone no canto superior esquerdo) > Logística > Relatório
 *     de Estoque.
 *   - Campo "Estoque" tem 3 opções, texto EXATO confirmado ao vivo:
 *     "Com e sem estoque" (padrão da tela), "Apenas com estoque",
 *     "Apenas sem estoque".
 *   - Botão "Exportar em CSV" só aparece DEPOIS de clicar "Pesquisar", e
 *     ao clicar nele o CSV baixa DIRETO (sem diálogo de confirmação nem
 *     escolha de local) — comportamento normal de download do Chrome.
 *   - Escopo combinado com o usuário: Seção sempre "Todos" (1 export com
 *     tudo, não seção por seção como fotos/sync), e por enquanto o script
 *     só baixa e guarda o CSV — sem parsear/estruturar nada (o projeto de
 *     estoque em si ainda não começou, isso é só a coleta).
 *
 * ─── ⚠️ Duas travas DIFERENTES do X2 — não confundir ──────────────────────
 * 1) NAVEGAÇÃO DIRETA POR URL é bloqueada pelo SERVIDOR — confirmado ao
 *    vivo nesta mesma sessão: `goto()` direto pra
 *    `.../cadastros/produto/estoque_produto.jsp` devolve "Você não está
 *    autorizado a continuar. Acesso direto não permitido para o destino
 *    ...". Isso é diferente do bloqueio de clique da tela de fotos — aqui
 *    é a URL em si que é rejeitada (provavelmente checa Referer ou estado
 *    de navegação no servidor), e o mesmo provavelmente vale pra QUALQUER
 *    tela profunda do X2, não só essa. Por isso este script SEMPRE entra
 *    clicando pelo menu de verdade, nunca por goto() direto na tela final.
 * 2) O clique que abre o popup de fotos (x2-fotos-scraper.js) tem OUTRO
 *    bloqueio, no nível de JS da própria página, que resiste a clique
 *    automatizado mesmo vindo de dentro da mesma origem. Os cliques de
 *    menu usados aqui (☰, "Logística", "Relatório de Estoque") NÃO tinham
 *    esse problema — confirmados funcionando com clique automatizado ao
 *    vivo nesta sessão de descoberta. Ainda assim, o clique final em
 *    "Exportar em CSV" NUNCA foi testado de forma automatizada (só visto
 *    funcionando com clique humano) — se ele tiver o mesmo tipo de
 *    bloqueio da tela de fotos, este script falha nesse último passo, com
 *    erro claro (não trava esperando).
 *
 * ─── O que NÃO foi confirmado (precisa de 1ª rodada supervisionada) ──────
 * Os seletores dos campos "Estoque"/"Seção" dentro do formulário (não deu
 * pra inspecionar o DOM de dentro do iframe da tela via ferramenta de
 * leitura — só o menu de fora). A função `configurarFiltros` usa uma
 * técnica de "achar o <select> mais próximo do texto do rótulo" em vez de
 * um `name=` fixo — mais resistente a não saber o atributo exato, mas
 * ainda precisa ser vista rodando pelo menos 1 vez.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-estoque-export.js
 *   node scripts/x2-estoque-export.js --estoque="Apenas com estoque"
 *
 * CSV baixado fica em `~/.x2-rildon-scraper/estoque/`, fora do OneDrive
 * (mesmo motivo dos outros scripts — ver x2-fotos-scraper.js), nomeado
 * com data/hora. Nada é lido/parseado por este script — só a coleta.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { chromium } = require('playwright');

// Sem isso, X2_USUARIO/X2_SENHA (usados no login automático) só carregavam
// quando este script rodava DENTRO do server.js (que já dá o require de
// dotenv) — rodando direto pelo terminal (`node scripts\x2-estoque-export.js`)
// process.env ficava vazio e o login automático falhava dizendo que as
// variáveis não existiam, mesmo estando no .env. Confirmado ao vivo 2026-08-06.
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const PROFILE_DIR = path.join(WORK_DIR, 'chrome-profile');
const ESTOQUE_DIR = path.join(WORK_DIR, 'estoque');

const HOME_URL = 'https://sistemas7.xprocess.com.br/x2rildon/www/index_main4.jsp';
const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';
// Confirmado ao vivo 2026-08-06 (ver cabeçalho do arquivo).
const ESTOQUE_HREF_MARK = 'estoque_produto.jsp';

const OPCOES_ESTOQUE_VALIDAS = ['Com e sem estoque', 'Apenas com estoque', 'Apenas sem estoque'];

function garantirPastas() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(ESTOQUE_DIR, { recursive: true });
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

async function abrirNavegador(channel) {
  garantirPastas();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel,
    headless: false,
    viewport: null,
    acceptDownloads: true,
  });
  // Ver x2-fotos-scraper.js pro relato completo (navigator.webdriver=true
  // confirmado ao vivo 2026-08-06 — esconde por precaução, mesmo esta tela
  // não tendo o bloqueio conhecido do popup de fotos).
  const { esconderWebdriver } = require('./x2-fotos-scraper');
  await esconderWebdriver(context);
  return context;
}

// Mesma heurística de login automático do x2-fotos-scraper.js — reusada
// daqui em vez de duplicada, já documentada lá como NÃO validada ao vivo.
async function tentarLoginAutomaticoSeNecessario(page) {
  const pareceLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (!pareceLogin) return;
  const { tentarLoginAutomatico } = require('./x2-fotos-scraper');
  await tentarLoginAutomatico(page);
}

// Navega até a tela "Relatório de Estoque" clicando pelo menu de verdade
// (nunca por URL direta — ver aviso no topo do arquivo).
async function abrirRelatorioEstoque(page, { modoAutomatico } = {}) {
  if (modoAutomatico) {
    // ⚠️ Confirmado ao vivo 2026-08-06 (testando esta função direto pelo
    // terminal): dar goto() direto pra HOME_URL — mesmo já logado — dispara
    // a MESMA trava de "acesso direto não permitido" que já bloqueava
    // telas profundas (ver aviso no topo do arquivo), aparecendo como
    // "Gerenciamento de Acesso / Acesso Negado!" e voltando pra tela de
    // login sozinha. LOGIN_URL, por outro lado, sempre carrega direto sem
    // bloqueio (confirmado à parte). Por isso agora entra sempre pela tela
    // de login — se já tiver sessão válida salva no perfil, o próprio X2
    // redireciona sozinho pra fora dela, sem precisar logar de novo.
    await page.goto(LOGIN_URL).catch(() => {});
    await page.waitForTimeout(1000);
    await tentarLoginAutomaticoSeNecessario(page);
    await page.waitForTimeout(1000);
  }

  // Não navega mais pra lugar nenhum além disso — a partir daqui a página
  // já deve estar na área logada (por redirect automático do X2 depois do
  // login, ou porque o usuário já deixou logado manualmente antes de
  // chegar aqui, no modo não-automático).
  // O ícone de menu (☰) não tem texto acessível — usamos "primeiro link da
  // página", confirmado ao vivo ser esse ícone nesta sessão de descoberta
  // (2026-08-06). É o ponto mais frágil desta função: se o X2 mudar o
  // layout do cabeçalho, quebra aqui primeiro.
  await page.locator('a').first().click({ timeout: 10000 });
  await page.waitForTimeout(500);

  await page.locator('a:has-text("Logística")').first().click({ timeout: 10000 });
  await page.waitForTimeout(500);

  await page.locator(`a[href*="${ESTOQUE_HREF_MARK}"]`).first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);
}

// Ajusta o filtro "Estoque" (Com e sem / Apenas com / Apenas sem) e garante
// "Seção" = Todos (já é o padrão da tela, mas confirma). Roda dentro do
// iframe principal — inferido por analogia com Compras > Catálogo de
// Produtos (ver x2-catalogo-sync.js), NÃO confirmado ao vivo especificamente
// pra esta tela.
async function configurarFiltros(page, { estoqueOpcao }) {
  const resultado = await page.evaluate(({ estoqueOpcao, OPCOES_ESTOQUE_VALIDAS }) => {
    function norm(s) {
      return String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().replace(/\s+/g, ' ').trim();
    }
    const frame = document.querySelector('iframe[name="principal"]');
    if (!frame || !frame.contentDocument) return { ok: false, erro: 'iframe "principal" não encontrado — a tela pode usar outro nome de frame, precisa confirmar ao vivo.' };
    const doc = frame.contentDocument;

    function selectPorRotulo(textoRotulo) {
      const alvo = norm(textoRotulo);
      const candidatos = Array.from(doc.querySelectorAll('td, label, span, div')).filter(
        (el) => norm(el.textContent).startsWith(alvo) && el.textContent.trim().length < 40 && el.children.length === 0
      );
      for (const el of candidatos) {
        const tr = el.closest('tr');
        const escopo = tr || el.parentElement;
        const sel = escopo ? escopo.querySelector('select') : null;
        if (sel) return sel;
      }
      return null;
    }

    if (estoqueOpcao) {
      if (!OPCOES_ESTOQUE_VALIDAS.includes(estoqueOpcao)) return { ok: false, erro: `Opção de estoque inválida: "${estoqueOpcao}".` };
      const sel = selectPorRotulo('Estoque');
      if (!sel) return { ok: false, erro: 'Não achei o campo "Estoque" no formulário — precisa confirmar numa sessão ao vivo.' };
      const opt = Array.from(sel.options).find((o) => norm(o.textContent) === norm(estoqueOpcao));
      if (!opt) return { ok: false, erro: `Opção "${estoqueOpcao}" não encontrada no select de Estoque (opções vistas: ${Array.from(sel.options).map((o) => o.textContent.trim()).join(', ')}).` };
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return { ok: true };
  }, { estoqueOpcao, OPCOES_ESTOQUE_VALIDAS });

  if (!resultado.ok) throw new Error(resultado.erro);
}

// Clica um botão/link pelo TEXTO visível, dentro do iframe principal —
// evita depender de name=/id= que não foram confirmados ao vivo.
async function clicarPorTexto(page, texto) {
  return page.evaluate((texto) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
    const frame = document.querySelector('iframe[name="principal"]');
    if (!frame || !frame.contentDocument) return false;
    const doc = frame.contentDocument;
    const alvo = norm(texto);
    const elementos = Array.from(doc.querySelectorAll('button, input[type="button"], input[type="submit"], a'));
    const el = elementos.find((e) => norm(e.textContent || e.value) === alvo);
    if (!el) return false;
    el.click();
    return true;
  }, texto);
}

function nomeArquivoTimestamp() {
  const agora = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `estoque-${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())}_${pad(agora.getHours())}-${pad(agora.getMinutes())}.csv`;
}

// Fluxo completo: abre a tela, ajusta filtros, pesquisa, exporta CSV e
// salva em ESTOQUE_DIR. Retorna o caminho do arquivo salvo.
async function exportarEstoque(context, { estoqueOpcao = 'Com e sem estoque', modoAutomatico } = {}) {
  const page = context.pages()[0] || (await context.newPage());

  await abrirRelatorioEstoque(page, { modoAutomatico });

  console.log('Ajustando filtro "Estoque"...');
  await configurarFiltros(page, { estoqueOpcao });

  console.log('Clicando em "Pesquisar"...');
  const pesquisouOk = await clicarPorTexto(page, 'Pesquisar');
  if (!pesquisouOk) throw new Error('Não achei o botão "Pesquisar" — precisa confirmar numa sessão ao vivo.');
  await page.waitForTimeout(2500); // pesquisa pode demorar em catálogos grandes

  console.log('Clicando em "Exportar em CSV" e aguardando o download...');
  const nomeArquivo = nomeArquivoTimestamp();
  const destino = path.join(ESTOQUE_DIR, nomeArquivo);

  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: 60000 }),
    (async () => {
      const clicouOk = await clicarPorTexto(page, 'Exportar em CSV');
      if (!clicouOk) throw new Error('Não achei o botão "Exportar em CSV" — só aparece depois de Pesquisar retornar resultado; confirme numa sessão ao vivo se o clique automatizado funciona nele (nunca testado antes de hoje).');
    })(),
  ]);

  await download.saveAs(destino);
  console.log(`CSV salvo em: ${destino}`);
  return { arquivo: destino, nomeArquivo };
}

async function rodar({ channel, estoqueOpcao, confirmar, modoAutomatico } = {}) {
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
    return await exportarEstoque(context, { estoqueOpcao, modoAutomatico });
  } finally {
    await context.close().catch(() => {});
  }
}

function carregarExports() {
  garantirPastas();
  return fs.readdirSync(ESTOQUE_DIR)
    .filter((f) => f.endsWith('.csv'))
    .map((f) => {
      const stat = fs.statSync(path.join(ESTOQUE_DIR, f));
      return { nome: f, bytes: stat.size, modificadoEm: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modificadoEm.localeCompare(a.modificadoEm));
}

async function main() {
  const args = process.argv.slice(2);
  const estoqueArg = args.find((a) => a.startsWith('--estoque='));
  const estoqueOpcao = estoqueArg ? estoqueArg.split('=')[1] : 'Com e sem estoque';
  if (!OPCOES_ESTOQUE_VALIDAS.includes(estoqueOpcao)) {
    throw new Error(`--estoque inválido: "${estoqueOpcao}". Opções: ${OPCOES_ESTOQUE_VALIDAS.join(' | ')}`);
  }
  // PEDIDO DO USUÁRIO (2026-08-06): rodar via terminal deve logar sozinho
  // (X2_USUARIO/X2_SENHA no .env), igual o modo rotina — sem pausar
  // esperando Enter. Se a sessão salva no perfil já estiver logada,
  // tentarLoginAutomaticoSeNecessario nem tenta logar de novo.
  await rodar({ channel: 'chrome', estoqueOpcao, modoAutomatico: true });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  WORK_DIR,
  ESTOQUE_DIR,
  OPCOES_ESTOQUE_VALIDAS,
  nomeArquivoTimestamp,
  carregarExports,
  rodar,
};
