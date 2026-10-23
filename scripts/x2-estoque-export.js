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
const crypto = require('crypto');
const readline = require('readline');
const { execFile } = require('child_process');
const { chromium } = require('playwright');
const { avaliarEmQualquerFrame, comRetry } = require('./x2-nav-helpers');

// Sem isso, X2_USUARIO/X2_SENHA (usados no login automático) só carregavam
// quando este script rodava DENTRO do server.js (que já dá o require de
// dotenv) — rodando direto pelo terminal (`node scripts\x2-estoque-export.js`)
// process.env ficava vazio e o login automático falhava dizendo que as
// variáveis não existiam, mesmo estando no .env. Confirmado ao vivo 2026-08-06.
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
// 2026-10-14: perfil por tipo de tarefa — ver scripts/x2-perfil-chrome.js.
// Antes todos compartilhavam 'chrome-profile', e duas tarefas simultaneas
// derrubavam uma a outra ("Target page, context or browser has been closed").
const PROFILE_DIR = require('./x2-perfil-chrome').perfilChrome('estoque');
const ESTOQUE_DIR = path.join(WORK_DIR, 'estoque');

const HOME_URL = 'https://sistemas7.xprocess.com.br/x2rildon/www/index_main4.jsp';
const LOGIN_URL = 'https://sistemas7.xprocess.com.br/seguranca/www/login_form.jsp';
// Confirmado ao vivo 2026-08-06 (ver cabeçalho do arquivo).
const ESTOQUE_HREF_MARK = 'estoque_produto.jsp';

const OPCOES_ESTOQUE_VALIDAS = ['Com e sem estoque', 'Apenas com estoque', 'Apenas sem estoque'];

const LIMIAR_COMPLETUDE_EXPORT = 0.9;

function validarCompletudeCsv(conteudo, linhasTabela, parseCsv) {
  const registrosCsv = parseCsv ? parseCsv(conteudo) : [];
  const linhasCsv = registrosCsv.length; // registros lógicos; quoted newlines não contam como novos produtos
  const linhasDadosTabela = Math.max(0, Number(linhasTabela) - 1); // tabela inclui cabeçalho
  let valido = linhasDadosTabela > 0 && Array.isArray(registrosCsv) && linhasCsv > 0;
  let motivo = null;
  if (linhasDadosTabela <= 0) motivo = 'não consegui contar as linhas da tabela do X2';
  else if (!Array.isArray(registrosCsv) || linhasCsv <= 0) motivo = 'o CSV baixado não tem nenhuma linha legível';
  else if (linhasCsv < linhasDadosTabela * LIMIAR_COMPLETUDE_EXPORT) {
    valido = false;
    motivo = 'o CSV veio com menos de 90% das linhas que a tela do X2 mostrava (conferência por amostragem, não é prova de que está completo)';
  }
  return { valido, linhasCsv, linhasTabela: linhasDadosTabela, motivo };
}

function nomeArquivoExecucao(nomeBase, id = crypto.randomUUID()) {
  const ext = path.extname(nomeBase);
  const stem = path.basename(nomeBase, ext);
  return `${stem}-${id}${ext}`;
}

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
    // 2026-10-23 (varredura): 20 das 29 execuções falhavam presas na tela de login, e
    // TODAS fora do horário comercial (19h-08h); todos os sucessos, entre 08h e 17h.
    // Testado ao vivo nesta data: o MESMO login automático, num perfil de Chrome novo,
    // entra sem problema (chega em index_main4.jsp) tanto headless quanto com janela,
    // até a partir de sessão não interativa. Ou seja: credenciais e mecanismo estão
    // certos — o que atrapalha é o estado velho do perfil reaproveitado (cookie de
    // sessão vencido + localStorage), que durante o expediente ainda está válido por
    // causa do uso humano e de madrugada não está. A limpeza já existia, mas só na 3ª
    // tentativa, quando a execução já tinha gasto as outras duas. Agora a sessão
    // automática começa SEMPRE limpa. Seguro: este perfil é exclusivo do estoque
    // (chrome-profile-estoque, ver x2-perfil-chrome.js), então não desloga ninguém das
    // telas de foto/catálogo.
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

  // Não navega mais pra lugar nenhum além disso — a partir daqui a página
  // já deve estar na área logada (por redirect automático do X2 depois do
  // login, ou porque o usuário já deixou logado manualmente antes de
  // chegar aqui, no modo não-automático).
  // O ícone de menu (☰) não tem texto acessível — usamos "primeiro link da
  // página", confirmado ao vivo ser esse ícone nesta sessão de descoberta
  // (2026-08-06). É o ponto mais frágil desta função: se o X2 mudar o
  // layout do cabeçalho, quebra aqui primeiro.
  // Tolerante (2026-10-16): a rotina agendada falhava com "waiting for
  // locator('a:has-text("Logística")')" porque o ☰ era SEMPRE clicado — se o
  // menu já estivesse aberto (perfil persistente reaproveitado), o clique o
  // fechava; e, com sessão expirada, não havia menu nenhum. Agora só clica
  // no ☰ se "Logística" ainda não estiver visível, tenta de novo, e na falha
  // informa em que página/estado estava.
  const linkLogistica = () => page.locator('a:has-text("Logística")').first();
  // 2026-10-23: 20 das últimas 29 execuções da rotina falharam aqui, sempre na
  // tela de login, e a causa ficava escondida — o erro do login automático era
  // engolido pelo .catch(() => {}) e alert()s do X2 (ex.: "usuário já logado")
  // eram descartados sem registro. Agora guarda os dois pro erro final.
  const mensagensDoX2 = [];
  const errosDeLogin = [];
  page.on('dialog', (d) => { mensagensDoX2.push(String(d.message()).slice(0, 200)); d.dismiss().catch(() => {}); });
  let logisticaOk = false;
  for (let tentativa = 0; tentativa < 3 && !logisticaOk; tentativa++) {
    if (await linkLogistica().isVisible().catch(() => false)) { logisticaOk = true; break; }
    // Última tentativa: descarta cookies/sessão possivelmente corrompidos e
    // entra de novo pela tela de login do zero.
    if (tentativa === 2) {
      await page.context().clearCookies().catch(() => {});
      await page.goto(LOGIN_URL).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await tentarLoginAutomaticoSeNecessario(page).catch((e) => { errosDeLogin.push(String(e && e.message || e).slice(0, 200)); });
    await page.locator('a').first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800 + tentativa * 700);
    logisticaOk = await linkLogistica().isVisible().catch(() => false);
  }
  if (!logisticaOk) {
    const estado = `url=${page.url()} | links=${await page.locator('a').count().catch(() => '?')} | senha=${await page.locator('input[type="password"]').count().catch(() => '?')}`;
    const textoTela = await page.evaluate(() => (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)).catch(() => '');
    const diag = ` | loginErro=${JSON.stringify(errosDeLogin.slice(-2))} | alertasX2=${JSON.stringify(mensagensDoX2.slice(-3))} | tela="${textoTela}"`;
    throw new Error(`Menu "Logística" não apareceu após 3 tentativas (${estado}${diag}). Sessão do X2 provavelmente expirada ou layout mudou — abra o X2 no painel, faça login e rode de novo.`);
  }
  await linkLogistica().click({ timeout: 10000 });
  await page.waitForTimeout(500);

  await page.locator(`a[href*="${ESTOQUE_HREF_MARK}"]`).first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);
}

// Ajusta o filtro "Estoque" (Com e sem / Apenas com / Apenas sem) e garante
// "Seção" = Todos (já é o padrão da tela, mas confirma).
//
// ⚠️ BUG REAL corrigido 2026-08-12, em 2 etapas (achado num teste completo do
// painel: a rotina "Atualizar Estoque Diário" tinha falhado nessa mesma
// manhã, export ficou 1 dia desatualizado):
//
// 1ª causa (real, mas não era a raiz): esta função assumia que o formulário
// sempre mora em `iframe[name="principal"]` e ia direto no `contentDocument`
// dele. Trocado por `avaliarEmQualquerFrame` (de x2-nav-helpers.js), que
// procura em TODOS os frames — mesmo padrão já usado em
// configurarFiltrosLancamentos (x2-lancamentos-scraper.js, 2026-08-11).
//
// 2ª causa (a raiz de verdade — só apareceu depois do fix acima, com um
// diagnóstico que lista URL da página + de cada frame): o frame certo
// (estoque_produto.jsp) SEMPRE esteve presente. O problema nunca foi
// navegação/frame — é que essa tela específica NÃO TEM campo "Unidade".
// Um dump ao vivo de todos os <select> do formulário (2026-08-12) confirmou:
// só existem Fornecedor, Fabricante, CST ICMS/PIS/COFINS, Seção, Linha,
// Sub-linha, Estoque e Custo — nenhum "Unidade". O PEDIDO DO USUÁRIO de
// 2026-08-11 ("sempre que tiver um campo de unidade... verifique os 3") foi
// aplicado aqui por analogia com outras telas do X2 que TÊM esse campo, sem
// confirmar ao vivo se ESTA tela também tinha — daí a rotina quebrar 100%
// das vezes desde então. Fix: trata "Unidade" como OPCIONAL nesta tela — se
// achar, seleciona "Todas" (mantém a intenção do pedido do usuário pras
// telas que têm o campo); se não achar, segue sem erro (não tem como um
// export sair "incompleto por unidade" numa tela que não tem esse filtro pra
// começo de conversa, então não faz sentido falhar alto por causa dele
// aqui). A âncora de frame agora é o select "Estoque" (ou "Seção" se
// `estoqueOpcao` não foi passado) — campos confirmados sempre presentes
// nessa tela pelo mesmo dump.
async function configurarFiltros(page, { estoqueOpcao }) {
  const buscar = () => avaliarEmQualquerFrame(page, ({ estoqueOpcao, OPCOES_ESTOQUE_VALIDAS }) => {
    function norm(s) {
      return String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().replace(/\s+/g, ' ').trim();
    }
    function selectPorRotulo(textoRotulo) {
      const alvo = norm(textoRotulo);
      const candidatos = Array.from(document.querySelectorAll('td, label, span, div')).filter(
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

    const selEstoque = selectPorRotulo('Estoque');
    const anchor = selEstoque || selectPorRotulo('Seção');
    if (!anchor) return null; // frame errado — avaliarEmQualquerFrame tenta o próximo

    // Opcional (ver comentário acima) — esta tela pode não ter esse campo.
    const selUnidade = selectPorRotulo('Unidade');
    let unidadeAjustada = false;
    if (selUnidade) {
      const optTodas = Array.from(selUnidade.options).find((o) => norm(o.textContent).includes('TODAS'));
      if (optTodas) {
        selUnidade.value = optTodas.value;
        selUnidade.dispatchEvent(new Event('change', { bubbles: true }));
        unidadeAjustada = true;
      }
    }

    if (estoqueOpcao) {
      if (!OPCOES_ESTOQUE_VALIDAS.includes(estoqueOpcao)) return { ok: false, erro: `Opção de estoque inválida: "${estoqueOpcao}".` };
      if (!selEstoque) return { ok: false, erro: 'Não achei o campo "Estoque" no formulário (frame certo, âncora foi "Seção") — precisa confirmar numa sessão ao vivo.' };
      const opt = Array.from(selEstoque.options).find((o) => norm(o.textContent) === norm(estoqueOpcao));
      if (!opt) return { ok: false, erro: `Opção "${estoqueOpcao}" não encontrada no select de Estoque (opções vistas: ${Array.from(selEstoque.options).map((o) => o.textContent.trim()).join(', ')}).` };
      selEstoque.value = opt.value;
      selEstoque.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return { ok: true, unidadeEncontrada: !!selUnidade, unidadeAjustada };
  }, { estoqueOpcao, OPCOES_ESTOQUE_VALIDAS });

  const { resultado } = await comRetry(buscar, (r) => r && r.resultado, { tentativas: 6, esperaMs: 1200 });

  if (!resultado) {
    const frames = page.frames().map((f, i) => `[${i}] ${f.url() || '(sem url)'}`).join(' | ');
    throw new Error(`Não achei os campos "Estoque"/"Seção" em nenhum frame da tela, mesmo tentando 6x (~7s) — a tela de Relatório de Estoque pode não ter carregado. Página: ${page.url()}. Frames: ${frames || '(nenhum frame)'}.`);
  }
  if (!resultado.ok) throw new Error(resultado.erro);
  if (!resultado.unidadeEncontrada) {
    console.log('(campo "Unidade" não existe nesta tela — confirmado 2026-08-12, não é erro; export cobre tudo que a tela mostra por padrão.)');
  }
}

// Clica um botão/link pelo TEXTO visível, dentro do iframe principal —
// acha o elemento certo via texto normalizado (evita depender de name=/id=
// não confirmados ao vivo), mas o CLIQUE em si é sempre um clique de
// VERDADE do Playwright (via CDP), nunca um el.click() sintético dentro da
// página.
//
// ⚠️ Corrigido 2026-08-07 (falha ao vivo: "Exportar em CSV" parecia clicar
// sem erro — clicarPorTexto retornava true — mas o
// context.waitForEvent('download') estourava 60s, 2x seguidas). Causa
// mais provável: el.click() disparado de DENTRO de page.evaluate() não
// conta como "gesto de usuário confiável" pro Chromium. Mesma categoria de
// bloqueio já documentada em x2-fotos-scraper.js pro botão "Catálogo de
// Produtos" (lá a saída foi evitar .click() de vez, setando .src direto —
// aqui não dá, precisa ser um clique de verdade no botão). 1ª correção:
// marca o elemento certo com um atributo temporário via evaluate, e clica
// nele de verdade via locator do Playwright (dispatcha um evento de mouse
// confiável via CDP — conta como gesto de usuário de verdade).
//
// ⚠️ 2ª correção, mesmo dia (falha ao vivo NUMA rodada de "Testar agora"
// da rotina "Lançamentos Semanais", confirmado no log de execução do
// painel): a 1ª correção resolveu o problema do clique não-confiável, mas
// revelou outro: `locator.click` deu "element is not visible" e depois
// "element was detached from the DOM, retrying" — o botão #botaoCSV (id
// confirmado ao vivo nesse mesmo log de erro) existe no DOM mas a tabela
// de resultados ("Com e sem estoque" pode ter milhares de linhas) ainda
// estava sendo (re)desenhada quando tentamos clicar, então o elemento que
// marcamos foi substituído por um novo (sem a marca) antes do clique
// completar. Fix: tenta o ciclo inteiro (marcar → clicar) até 3x, marcando
// de novo a cada tentativa — se a tabela ainda estiver instável na
// tentativa 1, a 2ª/3ª acha o elemento já estável. Ainda não validado ao
// vivo — próxima falha (se houver) deve trazer um log diferente.
//
// ⚠️ 3ª correção (2026-10-14, falha reproduzida ao vivo no servidor): o
// clique em "Exportar em CSV" passou a estourar o timeout de 8s SEM dar
// erro de elemento — o log do Playwright mostra "element is visible,
// enabled and stable" → "performing click action" → timeout. Isso é o
// sintoma clássico de o clique ter saído e a PÁGINA travar: o onclick
// chama exportTableToCSV() sobre uma tabela de ~17 mil linhas, o que
// bloqueia a thread principal do renderer por bem mais de 8s, e o
// Playwright não consegue confirmar o clique nesse meio tempo. Duas
// saídas, as duas usadas aqui: timeout maior pro clique (timeoutClique)
// e, com tolerarTimeout, NÃO tratar o estouro como falha — o clique
// provavelmente saiu, então quem decide é o waitForEvent('download') lá
// fora, que tem o seu próprio limite.
// Tempos do passo "Exportar em CSV" (ver o comentário do waitForEvent mais abaixo).
// O clique no botão pode travar a página do X2 por um bom tempo (a tela monta a tabela
// inteira em JS), por isso ele tolera timeout e tenta de novo; a espera do download
// precisa cobrir TODAS as tentativas mais o tempo de geração do arquivo no servidor.
const TIMEOUT_CLIQUE_CSV_MS = 60000;
const TENTATIVAS_CLIQUE_CSV = 3;
const FOLGA_GERACAO_CSV_MS = 60000;
const TIMEOUT_DOWNLOAD_MS = TENTATIVAS_CLIQUE_CSV * TIMEOUT_CLIQUE_CSV_MS + FOLGA_GERACAO_CSV_MS; // 240s

async function clicarPorTexto(page, texto, { tentativas = 3, timeoutClique = 8000, tolerarTimeout = false } = {}) {
  const MARK_ATTR = 'data-x2-click-target';
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const achou = await page.evaluate(({ texto, MARK_ATTR }) => {
      const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().trim();
      const frame = document.querySelector('iframe[name="principal"]');
      if (!frame || !frame.contentDocument) return false;
      const doc = frame.contentDocument;
      Array.from(doc.querySelectorAll(`[${MARK_ATTR}]`)).forEach((el) => el.removeAttribute(MARK_ATTR));
      const alvo = norm(texto);
      const elementos = Array.from(doc.querySelectorAll('button, input[type="button"], input[type="submit"], a'));
      const el = elementos.find((e) => norm(e.textContent || e.value) === alvo);
      if (!el) return false;
      el.setAttribute(MARK_ATTR, '1');
      return true;
    }, { texto, MARK_ATTR });

    if (!achou) return false; // elemento não existe de jeito nenhum — não adianta retentar

    try {
      await page.frameLocator('iframe[name="principal"]').locator(`[${MARK_ATTR}="1"]`).first().click({ timeout: timeoutClique });
      return true;
    } catch (e) {
      ultimoErro = e;
      // Estouro de tempo DEPOIS do clique ter sido despachado: segue em
      // frente em vez de falhar (ver comentário da 3ª correção acima).
      if (tolerarTimeout && /Timeout .* exceeded/i.test(e.message || '')) {
        console.log(`(clique em "${texto}" não confirmou em ${timeoutClique}ms — provavelmente a página travou gerando o arquivo; seguindo e esperando o download)`);
        return true;
      }
      if (tentativa < tentativas) {
        console.log(`(clique em "${texto}" falhou na tentativa ${tentativa}/${tentativas} — tabela ainda deve estar carregando, tentando de novo...)`);
        await page.waitForTimeout(1000);
      }
    }
  }

  throw new Error(`Clique em "${texto}" falhou depois de ${tentativas} tentativas: ${ultimoErro.message}`);
}

// ID confirmado ao vivo no onclick do botão: exportTableToCSV('Estoque
// Produto', 'tb_estoque_produto', [...]) — 2º argumento é o id da <table>.
const TABELA_ESTOQUE_ID = 'tb_estoque_produto';

function contarLinhasTabelaEstoque(page) {
  return page.evaluate((id) => {
    const frame = document.querySelector('iframe[name="principal"]');
    if (!frame || !frame.contentDocument) return -1;
    const tabela = frame.contentDocument.getElementById(id);
    return tabela ? tabela.rows.length : -1;
  }, TABELA_ESTOQUE_ID);
}

// Corrigido 2026-08-10 — CAUSA RAIZ da falha intermitente já mitigada (mas
// não resolvida) pelos 2 fixes anteriores em clicarPorTexto: depois de
// "Pesquisar", a tabela de resultados (até ~17.500 linhas em "Com e sem
// estoque") é preenchida progressivamente pelo X2, e o código sempre usou
// um `waitForTimeout` FIXO (2500ms → 4000ms) antes de exportar. Isso é uma
// corrida: se a tabela terminar de renderizar em menos tempo que o fixo,
// funciona (foi o que aconteceu nos testes manuais que "confirmaram"
// cada aumento); se o servidor/rede estiver mais lento naquele momento
// específico, o clique em "Exportar em CSV" acontece com a tabela ainda
// parcialmente preenchida — e o CSV sai pequeno (visto ao vivo: 344
// produtos / 61.7KB, várias vezes, mesmo depois de 4000ms). Os retries em
// clicarPorTexto só protegem o CLIQUE em si (elemento sendo substituído no
// DOM); não têm como saber se a tabela está com os dados TODOS ainda.
// Fix de verdade: substituir o tempo fixo por um polling que só avança
// quando o Nº DE LINHAS da tabela parar de crescer por `estabilidadeMs`
// seguidos (mesma ideia do waitForFunction em buscarSecao() do
// x2-catalogo-sync.js, adaptada pra "estabilidade" em vez de "texto
// específico apareceu", já que aqui não sabemos o total esperado de
// antemão).
async function aguardarTabelaEstavel(page, { timeoutMs = 30000, intervaloMs = 500, estabilidadeMs = 1500 } = {}) {
  const inicio = Date.now();
  let ultimaContagem = -1;
  let desdeQuandoEstavel = Date.now();

  while (Date.now() - inicio < timeoutMs) {
    const contagem = await contarLinhasTabelaEstoque(page);
    if (contagem !== ultimaContagem) {
      ultimaContagem = contagem;
      desdeQuandoEstavel = Date.now();
    } else if (contagem > 0 && Date.now() - desdeQuandoEstavel >= estabilidadeMs) {
      console.log(`(tabela estabilizou em ${contagem} linhas depois de ${Date.now() - inicio}ms)`);
      return contagem;
    }
    await page.waitForTimeout(intervaloMs);
  }

  console.log(`(aviso: tabela não estabilizou dentro de ${timeoutMs}ms — última contagem vista: ${ultimaContagem} linhas. Prosseguindo mesmo assim.)`);
  return ultimaContagem;
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
  // Espera de verdade (polling até o Nº de linhas parar de crescer) em vez
  // do tempo fixo antigo — ver comentário completo em aguardarTabelaEstavel
  // (causa raiz da falha intermitente de export incompleto, 2026-08-10).
  console.log('Aguardando a tabela de resultados carregar por completo...');
  const linhasEsperadas = await aguardarTabelaEstavel(page);

  console.log('Clicando em "Exportar em CSV" e aguardando o download...');
  const nomeArquivo = nomeArquivoExecucao(nomeArquivoTimestamp());
  const stagingDir = path.join(ESTOQUE_DIR, '.staging');
  const rejeitadosDir = path.join(ESTOQUE_DIR, 'rejeitados');
  fs.mkdirSync(stagingDir, { recursive: true });
  const temporario = path.join(stagingDir, nomeArquivo);
  const destino = path.join(ESTOQUE_DIR, nomeArquivo);

  // ⚠️ BUG REAL corrigido 2026-10-23 (reproduzido ao vivo disparando a rotina): a espera
  // do download era fixa em 90s enquanto o clique podia levar até 180s (3 tentativas de
  // 60s). Quando o X2 demora pra gerar o CSV, a espera estourava ANTES de o clique
  // terminar, e a execução morria com "Timeout 90000ms exceeded while waiting for event
  // download" mesmo estando tudo certo. O 90s tinha ficado pra trás quando o timeoutClique
  // subiu de 8s pra 60s (correção de 14/10). Agora os dois saem das MESMAS constantes, com
  // a invariante garantida por teste (x2-estoque-export.timeouts.test.js): a espera do
  // download sempre cobre o pior caso do clique mais a geração do arquivo.
  const [download] = await Promise.all([
    context.waitForEvent('download', { timeout: TIMEOUT_DOWNLOAD_MS }),
    (async () => {
      const clicouOk = await clicarPorTexto(page, 'Exportar em CSV', { tentativas: TENTATIVAS_CLIQUE_CSV, timeoutClique: TIMEOUT_CLIQUE_CSV_MS, tolerarTimeout: true });
      if (!clicouOk) throw new Error('Não achei o botão "Exportar em CSV" — só aparece depois de Pesquisar retornar resultado; confirme numa sessão ao vivo se o clique automatizado funciona nele (nunca testado antes de hoje).');
    })(),
  ]);

  await download.saveAs(temporario);
  console.log(`CSV baixado para staging: ${temporario}`);

  // Heurística de integridade: compara CSV parseado com a contagem observada
  // quando a tabela parou de crescer. O limiar de 90% reduz falsos aceites,
  // mas não prova completude do relatório.
  let verificacao;
  try {
    const conteudo = fs.readFileSync(temporario, 'utf8');
    const { parseCsvEstoque } = require('../src/services/estoque.service');
    verificacao = validarCompletudeCsv(conteudo, linhasEsperadas, parseCsvEstoque);
  } catch (e) {
    verificacao = { valido: false, motivo: `não consegui ler o CSV baixado: ${e.message}`, linhasTabela: Math.max(0, linhasEsperadas - 1), linhasCsv: 0 };
  }
  if (!verificacao.valido) {
    fs.mkdirSync(rejeitadosDir, { recursive: true });
    const rejeitado = path.join(rejeitadosDir, nomeArquivo.replace(/\.csv$/i, '.rejeitado.csv'));
    fs.renameSync(temporario, rejeitado);
    throw new Error(`Export recusado na conferência: ${verificacao.motivo} (a tela do X2 mostrava ${verificacao.linhasTabela} linhas e o CSV veio com ${verificacao.linhasCsv}). O arquivo foi guardado em ${rejeitado} e NADA foi importado — o estoque do bot continua com os dados anteriores.`);
  }
  // O identificador aleatório por execução evita colisões entre processos.
  // O rename publica o snapshot somente após a validação.
  fs.renameSync(temporario, destino);
  fs.writeFileSync(`${destino}.meta.json`, JSON.stringify({ estoqueOpcao, completo: estoqueOpcao === 'Com e sem estoque', validado: true, linhasCsv: verificacao.linhasCsv, linhasTabela: verificacao.linhasTabela, capturadoEm: new Date().toISOString() }, null, 2));
  console.log(`(conferência ok: ${verificacao.linhasCsv} produtos no CSV; a tela do X2 mostrava ${verificacao.linhasTabela} linhas)`);
  let importacao = { estado: 'nao_aplicavel', motivo: 'export filtrado não substitui o estoque completo no banco' };
  if (estoqueOpcao === 'Com e sem estoque') importacao = await _dispararImportacaoNoDocker(destino);
  else console.log('(filtered export saved for reference; database import skipped to avoid replacing full inventory with a subset)');

  return { arquivo: destino, nomeArquivo, importacao };
}

// Copia o CSV pra dentro do repo (src/data/estoque-latest.csv — mesma pasta
// que o volume do docker-compose.yml monta como /app/src/data dentro do
// container) e chama `docker exec chatbot_rildon_app npm run
// importar-estoque`. NUNCA importa direto no host (ver aviso no topo do
// arquivo e em src/services/estoque.service.js — Postgres nativo duplicado
// na porta 5432 causaria import silencioso no banco errado).
const REPO_ROOT = path.join(__dirname, '..');
const CSV_HANDOFF_HOST = path.join(REPO_ROOT, 'src', 'data', 'estoque-latest.csv');
const CSV_HANDOFF_CONTAINER = '/app/src/data/estoque-latest.csv';
const DOCKER_CONTAINER = 'chatbot_rildon_app';
const CSV_IMPORT_LOCK = path.join(ESTOQUE_DIR, 'estoque-import.lock');
const CSV_IMPORT_LOCK_STALE_MS = 15 * 60 * 1000;

function _lockObsoleto(caminhoLock) {
  try {
    const lock = JSON.parse(fs.readFileSync(caminhoLock, 'utf8'));
    const pid = Number(lock.pid);
    const adquiridoEm = Date.parse(lock.adquiridoEm);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(adquiridoEm)
      || Date.now() - adquiridoEm < CSV_IMPORT_LOCK_STALE_MS) return false;
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
  } catch (e) {
    // Arquivo incompleto/corrompido só pode ser recuperado depois de 1 hora;
    // isso cobre encerramento no intervalo entre criação e gravação do lock.
    try { return Date.now() - fs.statSync(caminhoLock).mtimeMs > 60 * 60 * 1000; } catch { return false; }
  }
}

function _removerLockObsoleto(caminhoLock) {
  const recoveryLock = `${caminhoLock}.recovery`;
  let fd;
  try {
    fd = fs.openSync(recoveryLock, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Uma queda durante a recuperação pode deixar o lock auxiliar para trás.
    // Só removemos após a mesma checagem PID + idade do lock principal.
    if (!_lockObsoleto(recoveryLock)) return false;
    try { fs.unlinkSync(recoveryLock); } catch { return false; }
    try { fd = fs.openSync(recoveryLock, 'wx'); } catch (retryError) {
      if (retryError.code === 'EEXIST') return false;
      throw retryError;
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, adquiridoEm: new Date().toISOString() }));
    if (!_lockObsoleto(caminhoLock)) return false;
    fs.unlinkSync(caminhoLock);
    return true;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(recoveryLock);
  }
}

async function executarComLockArquivo(caminhoLock, operacao) {
  const token = crypto.randomUUID();
  let fd;
  try {
    fd = fs.openSync(caminhoLock, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      if (!_removerLockObsoleto(caminhoLock)) return { acquired: false };
      try { fd = fs.openSync(caminhoLock, 'wx'); } catch (retryError) {
        if (retryError.code === 'EEXIST') return { acquired: false };
        throw retryError;
      }
    } else {
      throw e;
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, adquiridoEm: new Date().toISOString() }));
    await operacao();
    return { acquired: true };
  } finally {
    fs.closeSync(fd);
    try {
      const lock = JSON.parse(fs.readFileSync(caminhoLock, 'utf8'));
      if (lock.token === token) fs.unlinkSync(caminhoLock);
    } catch { /* lock já removido/trocado; não remover lock alheio */ }
  }
}

async function executarComLockComEspera(caminhoLock, operacao, {
  maxWaitMs = 2 * 60 * 1000,
  intervaloMs = 1000,
  aguardar = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const inicio = Date.now();
  while (true) {
    const resultado = await executarComLockArquivo(caminhoLock, operacao);
    if (resultado.acquired) return resultado;
    const decorrido = Date.now() - inicio;
    if (decorrido >= maxWaitMs) return { acquired: false, expirou: true };
    await aguardar(Math.min(intervaloMs, maxWaitMs - decorrido));
  }
}

async function _dispararImportacaoNoDocker(caminhoCsvOrigem) {
  fs.mkdirSync(ESTOQUE_DIR, { recursive: true });
  let estado;
  const resultado = await executarComLockComEspera(CSV_IMPORT_LOCK, async () => {
    estado = await _copiarEImportarNoDocker(caminhoCsvOrigem);
  });
  if (!resultado.acquired) {
    console.log('(importação pendente: lock continuou ocupado após 2 minutos; CSV e sidecar foram preservados, rode novamente para tentar importar)');
    return { estado: 'pendente', motivo: 'lock ocupado por mais de 2 minutos; snapshot preservado' };
  }
  return { estado: estado || 'concluida' };
}

async function _copiarEImportarNoDocker(caminhoCsvOrigem) {
  let origemMs;
  try { origemMs = Date.parse(JSON.parse(fs.readFileSync(`${caminhoCsvOrigem}.meta.json`, 'utf8')).capturadoEm); } catch {
    console.log('(importação recusada: sidecar de captura ausente ou inválido)');
    return 'falha_metadados';
  }
  const maisRecenteMs = fs.readdirSync(ESTOQUE_DIR)
    .filter((nome) => nome.endsWith('.csv'))
    .reduce((maior, nome) => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(ESTOQUE_DIR, `${nome}.meta.json`), 'utf8'));
        if (meta.validado === true && meta.completo === true && meta.estoqueOpcao === 'Com e sem estoque') {
          return Math.max(maior, Date.parse(meta.capturadoEm) || 0);
        }
      } catch { /* legado sem proveniência não altera a ordem de importação */ }
      return maior;
    }, 0);
  if (!Number.isFinite(origemMs) || origemMs < maisRecenteMs) {
    console.log('(importação ignorada: há snapshot completo mais recente que esta captura)');
    return 'ignorado_snapshot_antigo';
  }

  try {
    fs.mkdirSync(path.dirname(CSV_HANDOFF_HOST), { recursive: true });
    fs.copyFileSync(caminhoCsvOrigem, CSV_HANDOFF_HOST);
  } catch (e) {
    console.log(`(não consegui copiar o CSV pra ${CSV_HANDOFF_HOST}: ${e.message} — import pro banco não vai rodar.)`);
    return 'falha_copia';
  }

  console.log('Importando estoque pro banco (docker exec)...');
  return new Promise((resolve) => {
    execFile(
      'docker',
      ['exec', DOCKER_CONTAINER, 'npm', 'run', 'importar-estoque', '--', CSV_HANDOFF_CONTAINER],
      { timeout: 60000 },
      async (err, stdout, stderr) => {
        if (err) {
          try {
            require('./x2-whatsapp-alerta').enviarAlertaWhatsApp(`⚠️ Painel X2: o CSV de estoque foi baixado mas o import no banco falhou (${String(err.message).slice(0, 200)}). Preço/estoque do bot ficaram desatualizados.`).catch(() => {});
          } catch { /* best-effort */ }
          console.log(
            `(import pro banco não rodou: ${err.message} — o CSV foi baixado normalmente, só o "estoque ao vivo" do ` +
            `Catálogo que não atualizou. Confira se o Docker/container "${DOCKER_CONTAINER}" está rodando e a migration ` +
            '024 foi aplicada — pode rodar à mão depois com: docker exec ' + DOCKER_CONTAINER +
            ' npm run importar-estoque -- ' + CSV_HANDOFF_CONTAINER + ')'
          );
          resolve('falha_importacao');
        } else {
          console.log('Estoque importado pro banco.');
          if (stdout) console.log(stdout.trim());
          await _forcarReloadCacheEstoque();
          resolve('importado');
        }
      }
    );
  });
}

// PEDIDO DO USUÁRIO (2026-08-10): "sincronize em tempo real, quando eu baixo
// o novo csv... não atualiza a menos que eu clique em atualizar página" —
// investigando, o problema é mais fundo que o front: o `docker exec` acima
// grava no Postgres num processo Node AVULSO, mas o cache em memória do
// processo principal (usado pro badge de estoque no Catálogo) só recarregava
// no boot e a cada 30min (`setInterval` em src/server.js) — sem esse aviso
// aqui, o painel podia mostrar estoque desatualizado por até meia hora mesmo
// logo depois de um import bem-sucedido. Chama o endpoint novo
// (POST /api/catalogo/estoque/recarregar) pra forçar o reload na hora, MESMO
// padrão de scripts/x2-whatsapp-alerta.js (Bearer API_TOKEN, best-effort —
// se falhar, o import já está no banco e o setInterval de 30min ainda pega
// mais tarde, então não é motivo pra derrubar o export).
async function _forcarReloadCacheEstoque() {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken === 'troque_por_um_token_com_64_caracteres_ou_mais') {
    console.log('(API_TOKEN não configurado no .env — não deu pra forçar o reload do cache, só o setInterval de 30min do bot Rildon vai pegar essa atualização.)');
    return;
  }
  try {
    const { BASE_URL } = require('./x2-whatsapp-alerta');
    const resposta = await fetch(`${BASE_URL}/api/catalogo/estoque/recarregar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      console.log(`(reload do cache de estoque recusado pelo bot Rildon: HTTP ${resposta.status} — ${corpo.error || 'sem detalhe'}. O setInterval de 30min ainda vai atualizar sozinho.)`);
      return;
    }
    console.log(`Cache de estoque recarregado na hora — Catálogo do painel já reflete os ${corpo.produtos ?? '?'} produtos novos.`);
  } catch (e) {
    console.log(`(não consegui chamar o bot Rildon pra recarregar o cache de estoque: ${e.message}. O setInterval de 30min ainda vai atualizar sozinho.)`);
  }
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
  TIMEOUT_CLIQUE_CSV_MS,
  TENTATIVAS_CLIQUE_CSV,
  TIMEOUT_DOWNLOAD_MS,
  ESTOQUE_DIR,
  OPCOES_ESTOQUE_VALIDAS,
  nomeArquivoTimestamp,
  validarCompletudeCsv,
  nomeArquivoExecucao,
  executarComLockArquivo,
  executarComLockComEspera,
  carregarExports,
  rodar,
};
