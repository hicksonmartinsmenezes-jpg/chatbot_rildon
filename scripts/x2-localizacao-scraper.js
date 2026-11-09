#!/usr/bin/env node
/**
 * scripts/x2-localizacao-scraper.js
 *
 * PEDIDO DO USUÁRIO (2026-11-09): depois de uma varredura MANUAL (um por
 * um, via Claude-in-Chrome) de 208 produtos sem foto e com estoque pra
 * descobrir o Endereçamento (tela X2 ☰ > Logística > Localização de
 * Produto), o usuário pediu pra automatizar isso em Playwright dentro do
 * Lente Rildon (`scripts/x2-painel`), numa aba nova "Localizar".
 *
 * ─── Escopo combinado com o usuário (não mudar sem confirmar de novo) ────
 *  - Só produtos SEM FOTO e COM ESTOQUE (> 0) — mesmo filtro da lista
 *    manual já entregue, não o catálogo inteiro.
 *  - Só reprocessa código ainda PENDENTE (nunca refaz um já resolvido —
 *    ver `obterCodigosPendentes`/STATUS_FINAIS abaixo).
 *  - Resultado guardado em tabela ISOLADA no Postgres (`localizacoes_
 *    produtos`, migration 028) — pedido explícito do usuário, não uma
 *    coluna no cadastro de produto existente.
 *
 * ─── Fonte da fila (mesmo padrão do resto do Lente Rildon: lê snapshots
 * em disco, nunca consulta o Postgres direto do host — ver aviso em
 * src/services/estoque.service.js e scripts/importar-estoque.js. O
 * servidor do painel roda no host Windows, fora do Docker; o Postgres de
 * verdade só é alcançável de dentro do container) ───────────────────────
 *  - "Sem foto": `x2-painel-produtos-snapshot.js` ->
 *    `carregarListaQualidade('semFotoArquivo')` (aba Qualidade Cadastral,
 *    captura "Sem Foto/Arquivo" do Painel de Produtos do X2).
 *  - "Com estoque": CSV mais recente de `x2-estoque-export.js`
 *    (`carregarExports()[0]`), parseado com
 *    `src/services/estoque.service.js#parseCsvEstoque`.
 *  - "Ainda pendente": JSON local desta rodada
 *    (`~/.x2-rildon-scraper/localizacao/resultados.json`) — único arquivo
 *    que ESTE script escreve/lê pra saber o que já tentou antes. Depois de
 *    cada rodada, o conteúdo é enviado pro Postgres via `docker exec ...
 *    npm run importar-localizacao` (ver localizacao.service.js), mas o
 *    arquivo local continua sendo a fonte de verdade pra decidir "o que
 *    ainda falta" nas próximas rodadas — não dá pra consultar a tabela do
 *    Postgres direto do host pelo mesmo motivo do Estoque acima.
 *
 * ─── Navegação (mesma trava de URL direta documentada em
 * x2-estoque-export.js — ☰ > Logística sempre por clique de menu de
 * verdade, nunca goto() na tela final) ────────────────────────────────
 * Tela confirmada ao vivo na varredura manual (2026-11): ☰ > Logística >
 * "Localização de Produto" (URL relativa vista: `../cadastros/produto/
 * enderecamento/enderecamento_produto/painel.jsp` — href mark usado:
 * "enderecamento_produto"). Campo de busca "Código do Produto" + botão
 * "Pesquisar"; resultado numa tabela com colunas Cod. Prod./Cód.
 * Barras/Descrição/Estoque/Endereçamento/Excluir — 0, 1 ou mais linhas de
 * Endereçamento por produto (ex. real: código 116680 com 2 endereços,
 * juntados aqui com "; "; código 129391 sem nenhum, mostrando "Sem
 * Endereçamento.").
 *
 * ─── O que NÃO foi confirmado ao vivo (precisa de 1ª rodada supervisionada
 * — mesma ressalva de todo script novo deste projeto, ver x2-painel-
 * produtos-snapshot.js) ───────────────────────────────────────────────
 * Os seletores do campo "Código do Produto" e do botão "Pesquisar" dentro
 * do formulário: a varredura manual usou clique por coordenada de tela
 * (Claude-in-Chrome), nunca inspecionou o DOM de dentro do iframe. Este
 * script usa a MESMA técnica de "achar o <select>/<input> mais próximo do
 * rótulo" já validada em `configurarFiltros` (x2-estoque-export.js) e
 * `avaliarEmQualquerFrame` (x2-nav-helpers.js) em vez de um `name=`/`id=`
 * fixo — mais resistente, mas ainda precisa ser visto rodando pelo menos
 * 1 vez (rodar com o navegador visível e comparar com a tela).
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-localizacao-scraper.js
 *   node scripts/x2-localizacao-scraper.js --limite=20
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const { avaliarEmQualquerFrame, comRetry, salvarDiagnostico } = require('./x2-nav-helpers');

// Mesmo motivo do resto dos scripts X2 (ver x2-estoque-export.js linha ~71):
// sem isso, X2_USUARIO/X2_SENHA ficam vazios quando este script roda direto
// pelo terminal, fora do server.js.
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
// Perfil de Chrome próprio desta tarefa (2026-10-14: ver x2-perfil-chrome.js —
// tarefas simultâneas compartilhando 1 perfil derrubavam uma a outra).
const PROFILE_DIR = require('./x2-perfil-chrome').perfilChrome('localizacao');
const LOCALIZACAO_DIR = path.join(WORK_DIR, 'localizacao');
const RESULTADOS_PATH = path.join(LOCALIZACAO_DIR, 'resultados.json');

const HOME_URL = 'https://sistemas7.xprocess.com.br/x2rildon/www/index_main4.jsp';
const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';
// Ver cabeçalho do arquivo — ainda não confirmado ao vivo via inspeção de
// DOM (só visto funcionando por clique de menu na varredura manual).
const LOCALIZACAO_HREF_MARK = 'enderecamento_produto';
const LOCALIZACAO_TEXTO_MENU = 'Localização de Produto';

// Status que NUNCA são reprocessados numa rodada nova — "pendente" (nunca
// tentado) e "erro" (tentativa anterior falhou) sempre voltam pra fila.
const STATUS_FINAIS = ['encontrado', 'sem_enderecamento'];

function garantirPastas() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(LOCALIZACAO_DIR, { recursive: true });
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

// ─── Navegador / login — cópia do padrão já validado em
// x2-estoque-export.js (mesmo texto/comentários de contexto, não uma
// reescrita) ──────────────────────────────────────────────────────────
async function abrirNavegador(channel) {
  garantirPastas();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless: false, viewport: null });
  const { esconderWebdriver } = require('./x2-fotos-scraper');
  await esconderWebdriver(context);
  return context;
}

async function tentarLoginAutomaticoSeNecessario(page) {
  const pareceLogin = /login/i.test(page.url()) || (await page.locator('input[type="password"]').count().catch(() => 0)) > 0;
  if (!pareceLogin) return;
  const { tentarLoginAutomatico } = require('./x2-fotos-scraper');
  await tentarLoginAutomatico(page);
}

// ─── Fila: sem foto + com estoque + ainda pendente ───────────────────────

/** Lê a captura de "Sem Foto/Arquivo" da Qualidade Cadastral (Painel de
 * Produtos). Lança erro claro se a captura nunca rodou ainda — pede pro
 * usuário rodar a aba Qualidade Cadastral primeiro, em vez de seguir com
 * uma fila vazia/errada. */
function _carregarCodigosSemFoto() {
  const { carregarListaQualidade } = require('./x2-painel-produtos-snapshot');
  const captura = carregarListaQualidade('semFotoArquivo');
  if (!captura || !Array.isArray(captura.produtos) || !captura.produtos.length) {
    throw new Error('Nenhuma captura de "Sem Foto/Arquivo" encontrada ainda — rode "Capturar agora" na aba Qualidade Cadastral primeiro.');
  }
  // `produtos` é array de arrays alinhado com `headers` (ver
  // x2-painel-produtos-snapshot.js#_scrapearTabelaResultado) — acha a
  // coluna de código genericamente (contém "COD", não contém "BARRA"),
  // mesma técnica defensiva usada no resto do projeto pra não travar em
  // seletor fixo não confirmado ao vivo.
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const iCodigo = captura.headers.findIndex((h) => norm(h).includes('COD') && !norm(h).includes('BARRA'));
  if (iCodigo < 0) {
    throw new Error(`Não achei a coluna de código na captura "Sem Foto/Arquivo" (colunas: ${captura.headers.join(', ')}).`);
  }
  const mapa = new Map(); // codigo -> descricao (melhor esforço, só pra exibição)
  const iDescricao = captura.headers.findIndex((h) => norm(h).includes('DESCRI'));
  for (const linha of captura.produtos) {
    // Mesma normalização de código do CSV de estoque
    // (_normalizarCodigo em estoque.service.js) — sem isso, um código com
    // espaço/caixa diferente entre as duas fontes nunca cruzaria no Map.
    const codigo = String(linha[iCodigo] || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (codigo) mapa.set(codigo, iDescricao >= 0 ? String(linha[iDescricao] || '').trim() : '');
  }
  return mapa;
}

/** Lê o CSV de estoque mais recente e devolve Map codigo -> qtdEstoque. */
function _carregarEstoque() {
  const { carregarExports, ESTOQUE_DIR } = require('./x2-estoque-export');
  const { parseCsvEstoque } = require('../src/services/estoque.service');
  const exports = carregarExports();
  if (!exports.length) {
    throw new Error('Nenhum export de estoque encontrado ainda — rode "Baixar CSV agora" na aba Estoque primeiro.');
  }
  const conteudo = fs.readFileSync(path.join(ESTOQUE_DIR, exports[0].nome), 'utf8');
  const registros = parseCsvEstoque(conteudo);
  const mapa = new Map();
  for (const r of registros) mapa.set(String(r.codigo || '').trim(), Number(r.qtdEstoque) || 0);
  return mapa;
}

function carregarResultados() {
  garantirPastas();
  if (!fs.existsSync(RESULTADOS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(RESULTADOS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function salvarResultados(resultados) {
  garantirPastas();
  fs.writeFileSync(RESULTADOS_PATH, JSON.stringify(resultados, null, 2));
}

/** Monta a fila: código está na lista "sem foto" E tem qtdEstoque > 0 E
 * (nunca foi tentado OU a última tentativa não terminou em status final).
 * Retorna array de { codigo, nome, qtdEstoque }, ordenado por código. */
function obterCodigosPendentes() {
  const semFoto = _carregarCodigosSemFoto();
  const estoque = _carregarEstoque();
  const resultadosAnteriores = new Map(carregarResultados().map((r) => [r.codigo, r.status]));

  const pendentes = [];
  for (const [codigo, nome] of semFoto) {
    const qtdEstoque = estoque.get(codigo);
    if (!qtdEstoque || qtdEstoque <= 0) continue; // não está em estoque — fora do escopo combinado
    const statusAnterior = resultadosAnteriores.get(codigo);
    if (statusAnterior && STATUS_FINAIS.includes(statusAnterior)) continue; // já resolvido — nunca reprocessa
    pendentes.push({ codigo, nome, qtdEstoque });
  }
  pendentes.sort((a, b) => a.codigo.localeCompare(b.codigo));
  return pendentes;
}

// ─── Navegação até "Localização de Produto" ──────────────────────────────
async function abrirLocalizacaoProduto(page, { modoAutomatico } = {}) {
  if (modoAutomatico) {
    // Mesma lógica (e mesmo motivo) de x2-estoque-export.js#abrirRelatorioEstoque:
    // sessão velha de perfil persistente fora do expediente falha presa na
    // tela de login — sempre entra limpo pela tela de login em modo automático.
    await page.context().clearCookies().catch(() => {});
    await page.goto(LOGIN_URL).catch(() => {});
    await page.evaluate(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* origem sem storage acessível */ }
    }).catch(() => {});
    await page.goto(LOGIN_URL).catch(() => {});
    await page.waitForTimeout(1000);
    await tentarLoginAutomaticoSeNecessario(page);
    await page.waitForTimeout(1000);
  }

  const linkLogistica = () => page.locator('a:has-text("Logística")').first();
  let logisticaOk = false;
  for (let tentativa = 0; tentativa < 3 && !logisticaOk; tentativa++) {
    if (await linkLogistica().isVisible().catch(() => false)) { logisticaOk = true; break; }
    if (tentativa === 2) {
      await page.context().clearCookies().catch(() => {});
      await page.goto(LOGIN_URL).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await tentarLoginAutomaticoSeNecessario(page).catch(() => {});
    await page.locator('a').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800 + tentativa * 700);
    logisticaOk = await linkLogistica().isVisible().catch(() => false);
  }
  if (!logisticaOk) {
    throw new Error(`Menu "Logística" não apareceu após 3 tentativas (url=${page.url()}). Sessão do X2 provavelmente expirada ou layout mudou — abra o X2 no painel, faça login e rode de novo.`);
  }
  await linkLogistica().click({ timeout: 10000 });
  await page.waitForTimeout(500);

  const linkLocalizacao = page.locator(`a[href*="${LOCALIZACAO_HREF_MARK}"]`).first();
  if (await linkLocalizacao.count().catch(() => 0)) {
    await linkLocalizacao.click({ timeout: 10000 });
  } else {
    // Fallback por texto — ver cabeçalho do arquivo (href ainda não
    // confirmado por inspeção de DOM).
    const { clicarTextoExato } = require('./x2-nav-helpers');
    const frame = await clicarTextoExato(page, LOCALIZACAO_TEXTO_MENU);
    if (!frame) throw new Error(`Não achei "${LOCALIZACAO_TEXTO_MENU}" no menu Logística (nem por href "${LOCALIZACAO_HREF_MARK}", nem por texto).`);
  }
  await page.waitForTimeout(1200);
}

// ─── Clique "de verdade" (via CDP) em qualquer frame, por texto ──────────
// Mesma técnica de marcar-e-clicar de x2-estoque-export.js#clicarPorTexto,
// generalizada pra procurar em TODOS os frames (não só "iframe[name=
// principal]") — a tela de Localização ainda não teve o frame confirmado
// ao vivo, então não dá pra assumir um nome fixo (mesma lição já aprendida
// em configurarFiltros, ver comentário lá).
const MARK_ATTR = 'data-x2-click-target';
async function clicarPorTextoEmQualquerFrame(page, texto, { tentativas = 3, timeoutClique = 8000 } = {}) {
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const { frame } = await avaliarEmQualquerFrame(page, ({ texto, MARK_ATTR }) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
      document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => el.removeAttribute(MARK_ATTR));
      const alvo = norm(texto);
      const el = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
        .find((e) => norm(e.textContent || e.value) === alvo);
      if (!el) return null;
      el.setAttribute(MARK_ATTR, '1');
      return true;
    }, { texto, MARK_ATTR });
    if (!frame) { if (tentativa < tentativas) { await page.waitForTimeout(800); continue; } return false; }
    try {
      await frame.locator(`[${MARK_ATTR}="1"]`).first().click({ timeout: timeoutClique });
      return true;
    } catch (e) {
      if (tentativa === tentativas) throw new Error(`Clique em "${texto}" falhou depois de ${tentativas} tentativas: ${e.message}`);
      await page.waitForTimeout(1000);
    }
  }
  return false;
}

// ─── Buscar 1 código e ler o resultado ────────────────────────────────────

/** Preenche "Código do Produto" (achado pelo rótulo, igual
 * `configurarFiltros` de x2-estoque-export.js) em qualquer frame. */
async function preencherCodigo(page, codigo) {
  const buscar = () => avaliarEmQualquerFrame(page, ({ codigo }) => {
    function norm(s) {
      return String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().replace(/\s+/g, ' ').trim();
    }
    function inputPorRotulo(textoRotulo) {
      const alvo = norm(textoRotulo);
      const candidatos = Array.from(document.querySelectorAll('td, label, span, div')).filter(
        (el) => norm(el.textContent).startsWith(alvo) && el.textContent.trim().length < 40 && el.children.length === 0
      );
      for (const el of candidatos) {
        const tr = el.closest('tr');
        const escopo = tr || el.parentElement;
        const inp = escopo ? escopo.querySelector('input[type="text"], input:not([type])') : null;
        if (inp) return inp;
      }
      return null;
    }
    const campo = inputPorRotulo('Código do Produto') || inputPorRotulo('Código');
    if (!campo) return null; // frame errado — tenta o próximo
    // Setter nativo (não o .value do React/Vue, se houver) — mesma técnica
    // documentada pros <select> em configurarFiltros, aplicada a <input>.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(campo, codigo);
    campo.dispatchEvent(new Event('input', { bubbles: true }));
    campo.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { codigo });

  const { resultado } = await comRetry(buscar, (r) => r && r.resultado, { tentativas: 5, esperaMs: 1000 });
  if (!resultado) {
    throw new Error('Não achei o campo "Código do Produto" em nenhum frame da tela.');
  }
}

/** Lê a tabela de resultado: acha o cabeçalho com "Endereçamento", lê a(s)
 * linha(s) cujo "Cod. Prod." bate com `codigo`. Trata "Nenhum produto
 * encontrado" e "Sem Endereçamento." explicitamente — ver cabeçalho do
 * arquivo pros 2 casos reais já vistos na varredura manual. */
async function lerResultado(page, codigo) {
  const ler = () => avaliarEmQualquerFrame(page, ({ codigo }) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    const tabelas = Array.from(document.querySelectorAll('table'));
    for (const tabela of tabelas) {
      const linhas = Array.from(tabela.querySelectorAll('tr'));
      if (!linhas.length) continue;
      const celulasCabecalho = Array.from(linhas[0].querySelectorAll('th, td')).map((c) => norm(c.textContent));
      const iEndereco = celulasCabecalho.findIndex((c) => c.includes('ENDERECAMENTO'));
      const iCodigo = celulasCabecalho.findIndex((c) => c.includes('COD') && !c.includes('BARRA'));
      if (iEndereco < 0 || iCodigo < 0) continue; // não é a tabela de resultado — tenta a próxima
      const enderecos = [];
      for (const linha of linhas.slice(1)) {
        const celulas = Array.from(linha.querySelectorAll('td'));
        if (celulas.length <= Math.max(iEndereco, iCodigo)) continue;
        const codigoLinha = celulas[iCodigo].textContent.trim();
        if (codigoLinha !== String(codigo)) continue;
        enderecos.push(celulas[iEndereco].textContent.trim());
      }
      return { achouTabela: true, enderecos };
    }
    return null; // tabela ainda não carregou nesse frame — tenta de novo
  }, { codigo });

  const { resultado } = await comRetry(ler, (r) => r && r.resultado, { tentativas: 6, esperaMs: 1000 });
  if (!resultado) {
    throw new Error('Não achei a tabela de resultado (coluna "Endereçamento") em nenhum frame.');
  }
  const { enderecos } = resultado;
  if (!enderecos.length) {
    // Produto não apareceu na tabela de resultado nenhuma vez — pode ser
    // "Nenhum produto encontrado" (código inexistente nesta tela) ou a
    // busca não ter retornado nada. Tratado como erro (não como "sem
    // endereçamento") pra não confundir os dois casos no relatório.
    return { status: 'erro', endereco: null, erro: 'Produto não apareceu na tabela de resultado (verificar manualmente).' };
  }
  const semEndereco = enderecos.filter((e) => /SEM ENDERE/i.test(e) || !e.trim());
  if (semEndereco.length === enderecos.length) {
    return { status: 'sem_enderecamento', endereco: null, erro: null };
  }
  const validos = enderecos.filter((e) => e.trim() && !/SEM ENDERE/i.test(e));
  return { status: 'encontrado', endereco: validos.join('; '), erro: null };
}

/** Busca 1 código: preenche, clica "Pesquisar", lê o resultado. Nunca
 * lança pra fora — captura o erro e devolve status 'erro' (quem chama
 * decide se para ou continua a fila). */
async function buscarCodigo(page, codigo) {
  try {
    await preencherCodigo(page, codigo);
    await clicarPorTextoEmQualquerFrame(page, 'Pesquisar');
    await page.waitForTimeout(900);
    const resultado = await lerResultado(page, codigo);
    return { codigo, ...resultado };
  } catch (e) {
    await salvarDiagnostico(page, LOCALIZACAO_DIR, `erro-${codigo}`).catch(() => {});
    return { codigo, status: 'erro', endereco: null, erro: e.message };
  }
}

// ─── Handoff pro Postgres (mesmo padrão do Estoque — ver cabeçalho do
// arquivo e src/services/localizacao.service.js). Deliberadamente SEM a
// elaborada trava de arquivo (file lock) de x2-estoque-export.js: aqui não
// existe o cenário que a justificava (CSV gerado pelo próprio X2, baixado
// de fora do lock global do painel) — o lock único de `execucao.rodando`
// em server.js já garante que só uma tarefa Playwright roda por vez no
// painel. Overengineering evitado de propósito (ver AGENTS.md). ─────────
const REPO_ROOT = path.join(__dirname, '..');
const JSON_HANDOFF_HOST = path.join(REPO_ROOT, 'src', 'data', 'localizacao-latest.json');
const JSON_HANDOFF_CONTAINER = '/app/src/data/localizacao-latest.json';
const DOCKER_CONTAINER = 'chatbot_rildon_app';

async function _importarNoDocker(resultados) {
  try {
    fs.mkdirSync(path.dirname(JSON_HANDOFF_HOST), { recursive: true });
    fs.writeFileSync(JSON_HANDOFF_HOST, JSON.stringify(resultados, null, 2));
  } catch (e) {
    console.log(`(não consegui copiar o JSON pra ${JSON_HANDOFF_HOST}: ${e.message} — import pro banco não vai rodar; os dados continuam no arquivo local de progresso.)`);
    return 'falha_copia';
  }

  console.log('Importando localizações pro banco (docker exec)...');
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', DOCKER_CONTAINER, 'npm', 'run', 'importar-localizacao', '--', JSON_HANDOFF_CONTAINER],
      { timeout: 60000 },
      (err, stdout) => {
        if (err) {
          console.log(
            `(import pro banco não rodou: ${err.message} — os resultados foram salvos no arquivo local de progresso normalmente, só a tabela ` +
            `localizacoes_produtos que não atualizou. Confira se o Docker/container "${DOCKER_CONTAINER}" está rodando e a migration 028 foi ` +
            'aplicada — pode rodar à mão depois com: docker exec ' + DOCKER_CONTAINER + ' npm run importar-localizacao -- ' + JSON_HANDOFF_CONTAINER + ')'
          );
          resolve('falha_importacao');
        } else {
          console.log('Localizações importadas pro banco.');
          if (stdout) console.log(stdout.trim());
          resolve('importado');
        }
      }
    );
  });
}

// ─── Entrada principal ────────────────────────────────────────────────────

/**
 * Roda a busca pra todos os códigos pendentes (ou só os primeiros `limite`,
 * se informado). Processa 1 por vez, salva progresso incrementalmente no
 * arquivo local (resiliente a interrupção no meio) e importa pro Postgres
 * ao final. Retorna { total, encontrados, semEnderecamento, erros }.
 */
async function rodar({ channel, confirmar, modoAutomatico, deveParar, limite } = {}) {
  const pendentes = obterCodigosPendentes();
  const fila = limite ? pendentes.slice(0, limite) : pendentes;
  if (!fila.length) {
    console.log('Nenhum código pendente — todos os produtos sem foto e com estoque já têm localização resolvida (ou a fila está vazia).');
    return { total: 0, encontrados: 0, semEnderecamento: 0, erros: 0 };
  }
  console.log(`${fila.length} código(s) pendente(s) pra buscar (de ${pendentes.length} no total da fila).`);

  const context = await abrirNavegador(channel);
  const resumo = { total: 0, encontrados: 0, semEnderecamento: 0, erros: 0 };
  try {
    const page = context.pages()[0] || (await context.newPage());
    if (!modoAutomatico) {
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

    await abrirLocalizacaoProduto(page, { modoAutomatico });

    const resultadosAcumulados = carregarResultados();
    const porCodigo = new Map(resultadosAcumulados.map((r) => [r.codigo, r]));

    for (const item of fila) {
      if (deveParar && deveParar()) {
        console.log('\n⏹ Cancelado pelo usuário — progresso já salvo até aqui.');
        break;
      }
      console.log(`Buscando ${item.codigo} (${item.nome || 'sem descrição'})...`);
      const r = await buscarCodigo(page, item.codigo);
      porCodigo.set(r.codigo, { ...r, atualizadoEm: new Date().toISOString() });
      salvarResultados(Array.from(porCodigo.values())); // salva a cada item — resiliente a interrupção

      resumo.total += 1;
      if (r.status === 'encontrado') { resumo.encontrados += 1; console.log(`  -> ${r.endereco}`); }
      else if (r.status === 'sem_enderecamento') { resumo.semEnderecamento += 1; console.log('  -> sem endereçamento.'); }
      else { resumo.erros += 1; console.log(`  -> erro: ${r.erro}`); }
    }

    console.log(`\nResumo: ${resumo.encontrados} encontrado(s), ${resumo.semEnderecamento} sem endereçamento, ${resumo.erros} erro(s) (${resumo.total} processado(s) nesta rodada).`);

    const resultadosFinal = Array.from(porCodigo.values());
    const importacao = await _importarNoDocker(resultadosFinal);
    return { ...resumo, importacao };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const limiteArg = process.argv.find((a) => a.startsWith('--limite='));
  const limite = limiteArg ? Number(limiteArg.split('=')[1]) : undefined;
  await rodar({ channel: 'chrome', limite });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\nErro fatal:', err.message);
    process.exit(1);
  });
}

module.exports = {
  WORK_DIR,
  LOCALIZACAO_DIR,
  RESULTADOS_PATH,
  STATUS_FINAIS,
  obterCodigosPendentes,
  carregarResultados,
  salvarResultados,
  buscarCodigo,
  rodar,
};
