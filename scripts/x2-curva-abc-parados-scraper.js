#!/usr/bin/env node
/**
 * scripts/x2-curva-abc-parados-scraper.js
 *
 * PEDIDO DO USUÁRIO (2026-08-10): junto do alerta de "Cortes de Produtos"
 * (estoque baixo), o usuário também pediu "alerta de produtos que estão por
 * algum tempo sem sair" — explorando o X2 ao vivo (☰ > Compras > Curva ABC)
 * achamos que a tela **Curva ABC de Vendas** já tem exatamente o filtro e a
 * coluna certos pra isso, sem precisar de nenhuma tela nova:
 *   - Radio "Considerar Produtos sem Venda na Curva C?" → "Sim, considere os
 *     produtos sem venda no período e com estoque" (`considerarProdutosSemVenda=S`).
 *   - Radio "Curvas à Exibir" → "Curva C" (`exibirCurva=C`) — Curva C é onde
 *     esse toggle enfia os produtos sem venda nenhuma no período, junto com
 *     os 5% de produtos de menor giro. Filtrar server-side pra só Curva C
 *     evita trazer os milhares de produtos das Curvas A/B que não interessam
 *     pro alerta.
 *   - Checkbox "Dias Sem Faturamento" (`diasSemFaturamento`) — coluna literal
 *     de dias sem vender.
 *   - Checkbox "Qtde Estoque Atual" (`ckQtdeEstoqueAtual`) — pra saber se
 *     vale a pena alertar (produto parado SEM estoque não é o mesmo
 *     problema).
 * Cadência combinada: SEMANAL (um produto parado continua parado no dia
 * seguinte — alertar todo dia só repetiria a mesma lista e cansaria).
 *
 * ─── Navegação e seletores (confirmados ao vivo 2026-08-10) ───────────────
 * ☰ > tile "Compras" > link "Curva ABC". Formulário mora no 2º frame
 * (`window.frames[1]`) — mesmo padrão de outras telas do X2 já automatizadas
 * neste projeto. Nomes de campo REAIS confirmados via JS no Chrome do
 * usuário (não são heurística): `dataIni`/`dataFim` (texto dd/mm/aaaa),
 * radios `considerarProdutosSemVenda` (S/N) e `exibirCurva` (''/A/B/C),
 * checkboxes `diasSemFaturamento` e `ckQtdeEstoqueAtual`, botão
 * `onclick="atualizar()"` com texto "Atualizar Painel". Tabela de resultado
 * tem `id="tabela"` — cabeçalho real: "Curva | Pos. na Curva | Código do
 * Produto | Descrição do Produto | Preço Venda Atual Varejo | % do Total do
 * Valor Líquido | % Acumulado | Unid | Qtde Estoque Atual | Dias Sem
 * Faturamento" (as duas últimas só aparecem com os checkboxes marcados).
 *
 * ⚠️ ESCOPO: só produto/estoque/dias — sem nome de cliente nem vendedor
 * (essa tela nem expõe isso, diferente de Cortes de Produtos).
 *
 * ─── O que NÃO foi confirmado ao vivo (via Playwright) ────────────────────
 * Os seletores acima foram confirmados via JS no Chrome REAL do usuário
 * (Claude in Chrome), não pelo Playwright automatizado — mesma ressalva de
 * todo script novo deste projeto: precisa de 1ª rodada supervisionada
 * clicando "Rodar agora" no painel.
 *
 * ─── Uso ────────────────────────────────────────────────────────────────
 *   node scripts/x2-curva-abc-parados-scraper.js
 *
 * Por padrão considera os últimos 90 dias de vendas (`diasHistorico`,
 * configurável) — período largo o bastante pra não confundir "parado" com
 * "só não vendeu essa semana por acaso". Cada execução SOBRESCREVE
 * `~/.x2-rildon-scraper/curva-abc-parados/ultima-captura.json` e ACRESCENTA
 * uma entrada em `historico.json`. No fim, dispara o alerta de WhatsApp
 * (`x2-whatsapp-alerta.js`) — a menos que `semAlerta: true` seja passado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  WORK_DIR: RAIZ_WORK_DIR,
  LOGIN_URL,
  abrirNavegador,
  tentarLoginAutomaticoSeNecessario,
  clicarTextoExato,
  avaliarEmQualquerFrame,
  comRetry,
  salvarDiagnostico,
} = require('./x2-nav-helpers');
const { enviarAlertaWhatsApp } = require('./x2-whatsapp-alerta');

const PARADOS_DIR = path.join(RAIZ_WORK_DIR, 'curva-abc-parados');
const HISTORICO_PATH = path.join(PARADOS_DIR, 'historico.json');
const ULTIMA_CAPTURA_PATH = path.join(PARADOS_DIR, 'ultima-captura.json');

const DIAS_HISTORICO_PADRAO = 90;

function garantirPastas() {
  fs.mkdirSync(PARADOS_DIR, { recursive: true });
}

function ask(pergunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pergunta, (resposta) => { rl.close(); resolve(resposta); }));
}

function formatarDataBr(data) {
  const dd = String(data.getDate()).padStart(2, '0');
  const mm = String(data.getMonth() + 1).padStart(2, '0');
  const yyyy = data.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/** Navega até "Compras > Curva ABC". Mesmo formato de abertura das outras
 * telas já automatizadas (entra pela LOGIN_URL em modo automático — goto()
 * direto na tela final é bloqueado pelo servidor, ver x2-estoque-export.js). */
async function abrirCurvaAbc(page, { modoAutomatico } = {}) {
  if (modoAutomatico) {
    await page.goto(LOGIN_URL).catch(() => {});
    await page.waitForTimeout(1000);
    await tentarLoginAutomaticoSeNecessario(page);
    await page.waitForTimeout(1000);
  }

  await page.locator('a').first().click({ timeout: 10000 }); // ☰
  await page.waitForTimeout(500);

  const clicouCompras = await comRetry(
    () => clicarTextoExato(page, 'Compras'),
    (frame) => !!frame,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicouCompras) {
    await salvarDiagnostico(page, PARADOS_DIR, 'sem-tile-compras');
    throw new Error('Não encontrei o tile "Compras" no menu ☰. Diagnóstico salvo em debug-sem-tile-compras.png/.json.');
  }
  await page.waitForTimeout(800);

  const clicouCurvaAbc = await comRetry(
    () => clicarTextoExato(page, 'Curva ABC'),
    (frame) => !!frame,
    { tentativas: 6, esperaMs: 1000 }
  );
  if (!clicouCurvaAbc) {
    await salvarDiagnostico(page, PARADOS_DIR, 'sem-link-curva-abc');
    throw new Error('Cliquei em "Compras" mas não achei o link "Curva ABC" no submenu. Diagnóstico salvo em debug-sem-link-curva-abc.png/.json.');
  }
  await page.waitForTimeout(1500);
}

/** Configura os filtros pra isolar "produtos parados" — nomes de campo
 * REAIS confirmados ao vivo (ver cabeçalho do arquivo), não heurística.
 * Dispara 'input'/'change' via JS igual ao resto do projeto (clique
 * sintético em radio/checkbox às vezes não dispara o listener da tela — ver
 * `_selecionarTodasNaLinha` em x2-painel-produtos-snapshot.js pro mesmo
 * problema já resolvido assim).
 *
 * ⚠️ PEDIDO DO USUÁRIO (2026-08-11): "sempre que tiver um campo de unidade,
 * perceba sempre que tem 3 unidades, a matriz, a distribuidora e o
 * ecommerce, preciso que sempre verifique os 3". Esta tela tem um grupo de
 * checkboxes "Empresas" (as 3 unidades) — confirmado ao vivo que aparecem
 * marcadas por padrão, mas o script nunca tinha VERIFICADO isso
 * explicitamente, só confiava no default da tela (mesmo risco de qualquer
 * filtro deixado de uma busca manual anterior na mesma aba — já é o motivo
 * pelo qual x2-catalogo-sync.js reseta filtros toda vez). `marcarTodasEmpresas`
 * abaixo garante as 3 marcadas, achando os checkboxes pelo texto do label
 * (contém "RILDON", presente nas 3 opções) em vez de depender de um `name`
 * de campo nunca confirmado/documentado pra esse grupo especificamente.
 */
async function configurarFiltrosParados(page, { diasHistorico = DIAS_HISTORICO_PADRAO } = {}) {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - diasHistorico * 24 * 60 * 60 * 1000);

  const { resultado } = await avaliarEmQualquerFrame(page, ({ dataIniTexto, dataFimTexto }) => {
    const marcar = (name, value) => {
      const els = Array.from(document.querySelectorAll(`input[name="${name}"]`));
      const alvo = value === undefined
        ? els.find((e) => e.type === 'checkbox')
        : els.find((e) => e.value === value);
      if (!alvo) return false;
      if (alvo.type === 'checkbox') alvo.checked = true;
      else alvo.checked = true;
      alvo.dispatchEvent(new Event('click', { bubbles: true }));
      alvo.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const preencherData = (name, texto) => {
      const el = document.querySelector(`input[name="${name}"]`);
      if (!el) return false;
      el.value = texto;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const marcarTodasEmpresas = () => {
      const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toUpperCase().replace(/\s+/g, ' ').trim();
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((b) => {
        const label = b.closest('label') || b.parentElement;
        return label && norm(label.textContent).includes('RILDON');
      });
      if (boxes.length < 3) return false; // esperamos Matriz + Distribuidora + Ecommerce
      boxes.forEach((b) => {
        if (!b.checked) {
          b.checked = true;
          b.dispatchEvent(new Event('click', { bubbles: true }));
          b.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      return true;
    };

    const ok = {
      dataIni: preencherData('dataIni', dataIniTexto),
      dataFim: preencherData('dataFim', dataFimTexto),
      considerarSemVenda: marcar('considerarProdutosSemVenda', 'S'),
      exibirCurvaC: marcar('exibirCurva', 'C'),
      diasSemFaturamento: marcar('diasSemFaturamento'),
      qtdeEstoqueAtual: marcar('ckQtdeEstoqueAtual'),
      empresas: marcarTodasEmpresas(),
    };
    return ok;
  }, { dataIniTexto: formatarDataBr(inicio), dataFimTexto: formatarDataBr(hoje) });

  if (!resultado) return null;
  const faltando = Object.entries(resultado).filter(([, ok]) => !ok).map(([campo]) => campo);
  if (faltando.length) {
    return { ok: false, faltando };
  }
  return { ok: true };
}

async function clicarAtualizarPainel(page) {
  const frame = await clicarTextoExato(page, 'Atualizar Painel');
  return !!frame;
}

/** Extrai a tabela `id="tabela"` de forma genérica (acha os índices de
 * coluna pelo texto do cabeçalho, não por posição fixa — evita quebrar se o
 * X2 reordenar colunas). Faz polling até a contagem de linhas parar de
 * crescer, mesma técnica já validada em `_aguardarTabelaResultadoEstavel`
 * (x2-painel-produtos-snapshot.js). */
async function _lerTabelaParados(page) {
  const { resultado } = await avaliarEmQualquerFrame(page, () => {
    const tabela = document.getElementById('tabela');
    if (!tabela) return null;
    const linhas = Array.from(tabela.querySelectorAll('tr'));
    if (linhas.length < 2) return { headers: [], produtos: [] };
    const headers = Array.from(linhas[0].querySelectorAll('th, td')).map((c) => c.textContent.trim());
    const produtos = linhas.slice(1)
      .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.trim()))
      .filter((celulas) => celulas.some((c) => c));
    return { headers, produtos };
  });
  return resultado || { headers: [], produtos: [] };
}

async function _aguardarTabelaParadosEstavel(page, { timeoutMs = 25000, intervaloMs = 500, estabilidadeMs = 1500 } = {}) {
  const inicio = Date.now();
  let melhor = { headers: [], produtos: [] };
  let ultimaContagem = -1;
  let desdeQuandoEstavel = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const atual = await _lerTabelaParados(page);
    if (atual.produtos.length >= melhor.produtos.length) melhor = atual;
    if (atual.produtos.length !== ultimaContagem) {
      ultimaContagem = atual.produtos.length;
      desdeQuandoEstavel = Date.now();
    } else if (ultimaContagem >= 0 && Date.now() - desdeQuandoEstavel >= estabilidadeMs) {
      return melhor;
    }
    await page.waitForTimeout(intervaloMs);
  }
  return melhor;
}

/** Converte a tabela crua (headers + arrays de texto) numa lista de objetos
 * usando os nomes de coluna reais — indiferente à ordem/posição. */
function _normalizarProdutosParados(headers, produtos) {
  const idx = (parcial) => headers.findIndex((h) => h.toUpperCase().includes(parcial));
  const iCodigo = idx('CÓDIGO');
  const iDescricao = idx('DESCRIÇÃO');
  const iDias = idx('DIAS SEM FATURAMENTO');
  const iEstoque = idx('QTDE ESTOQUE');
  const iPreco = idx('PREÇO VENDA');

  return produtos.map((linha) => ({
    codigo: iCodigo !== -1 ? linha[iCodigo] : null,
    descricao: iDescricao !== -1 ? linha[iDescricao] : null,
    diasSemFaturamento: iDias !== -1 ? Number(String(linha[iDias]).replace(/\D/g, '')) || 0 : null,
    qtdeEstoqueAtual: iEstoque !== -1 ? Number(String(linha[iEstoque]).replace(/\./g, '').replace(',', '.')) || 0 : null,
    precoVendaAtual: iPreco !== -1 ? Number(String(linha[iPreco]).replace(/\./g, '').replace(',', '.')) || 0 : null,
  }));
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

/** Monta o texto do alerta — função pura, testável sem navegador. Só
 * considera produtos que ainda têm estoque (parado SEM estoque não é
 * problema de giro, é falta — isso já é coberto pelo alerta de Cortes). */
function montarMensagemAlerta(snapshot) {
  const comEstoque = snapshot.produtos
    .filter((p) => (p.qtdeEstoqueAtual || 0) > 0)
    .sort((a, b) => (b.diasSemFaturamento || 0) - (a.diasSemFaturamento || 0));

  if (!comEstoque.length) {
    return `🐌 *Produtos Parados (X2)* — nenhum produto com estoque parado nos últimos ${snapshot.diasHistorico} dias. 👍`;
  }

  const linhas = comEstoque
    .slice(0, 10)
    .map((p) => `• ${p.descricao} (cód. ${p.codigo}) — ${p.diasSemFaturamento}d sem vender, ${p.qtdeEstoqueAtual} em estoque`)
    .join('\n');
  const rodape = comEstoque.length > 10 ? `\n… e mais ${comEstoque.length - 10} produto(s).` : '';

  return (
    `🐌 *Produtos Parados (X2) — Curva C, últimos ${snapshot.diasHistorico} dias*\n\n` +
    `${comEstoque.length} produto(s) com estoque parado.\n\n` +
    `${linhas}${rodape}`
  );
}

async function capturarProdutosParados(context, { modoAutomatico, diasHistorico = DIAS_HISTORICO_PADRAO } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await abrirCurvaAbc(page, { modoAutomatico });

  const filtros = await comRetry(
    () => configurarFiltrosParados(page, { diasHistorico }),
    (r) => r && r.ok,
    { tentativas: 6, esperaMs: 1200 }
  );
  if (!filtros || !filtros.ok) {
    await salvarDiagnostico(page, PARADOS_DIR, 'sem-filtros');
    throw new Error(`Não consegui configurar todos os filtros da Curva ABC (faltando: ${filtros ? filtros.faltando.join(', ') : 'formulário inteiro'}). Diagnóstico salvo em debug-sem-filtros.png/.json.`);
  }
  await page.waitForTimeout(500);

  const clicou = await comRetry(
    () => clicarAtualizarPainel(page),
    (ok) => ok === true,
    { tentativas: 4, esperaMs: 800 }
  );
  if (!clicou) {
    await salvarDiagnostico(page, PARADOS_DIR, 'sem-botao-atualizar');
    throw new Error('Não encontrei o botão "Atualizar Painel". Diagnóstico salvo em debug-sem-botao-atualizar.png/.json.');
  }

  const { headers, produtos: linhasCruas } = await _aguardarTabelaParadosEstavel(page);
  const produtos = _normalizarProdutosParados(headers, linhasCruas);

  return {
    capturadoEm: new Date().toISOString(),
    diasHistorico,
    produtos,
  };
}

async function rodar({ channel, confirmar, modoAutomatico, diasHistorico, semAlerta, numeroAlerta } = {}) {
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

    const snapshot = await capturarProdutosParados(context, { modoAutomatico, diasHistorico });
    salvarCaptura(snapshot);
    console.log(`Captura salva: ${snapshot.produtos.length} produto(s) na Curva C (${snapshot.diasHistorico} dias).`);

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
  PARADOS_DIR,
  HISTORICO_PATH,
  ULTIMA_CAPTURA_PATH,
  DIAS_HISTORICO_PADRAO,
  formatarDataBr,
  abrirCurvaAbc,
  configurarFiltrosParados,
  capturarProdutosParados,
  montarMensagemAlerta,
  salvarCaptura,
  carregarUltimaCaptura,
  carregarHistorico,
  rodar,
};
