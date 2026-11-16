/**
 * estoque.service.js — estoque em tempo (quase) real pro Catálogo X2.
 *
 * PEDIDO DO USUÁRIO (2026-08-07): "Estoque ao vivo no Catálogo/orçamento" —
 * depois de validar `scripts/x2-estoque-export.js` (baixa o Relatório de
 * Estoque do X2 em CSV, automatizado), o usuário escolheu como próximo passo
 * mostrar "X em estoque"/"Sem estoque" na busca do Catálogo do painel e no
 * fluxo de orçamento do atendente.
 *
 * ─── Como o dado chega até aqui ────────────────────────────────────────────
 * `scripts/x2-estoque-export.js` roda no HOST (Windows, fora do Docker —
 * precisa de Chrome de verdade) e salva o CSV em `~/.x2-rildon-scraper/
 * estoque/*.csv`. Depois de salvar, ele copia esse CSV pra
 * `src/data/estoque-latest.csv` (dentro do repo, gitignored) e dispara
 * `docker exec chatbot_rildon_app npm run importar-estoque -- ...` — ou
 * seja, o PARSE e o INSERT no banco só acontecem DENTRO do container,
 * nunca no host. Isso é obrigatório, não estilo: ver memória do projeto
 * "Postgres duplicado na porta 5432" — qualquer comando de banco rodado
 * direto no host Windows cai no Postgres NATIVO errado, mesmo com .env
 * correto. `scripts/importar-estoque.js` é o único ponto de entrada válido
 * pra popular a tabela `estoque_produtos`.
 *
 * ─── Cache em memória ───────────────────────────────────────────────────
 * `catalogo-x2.service.js` monta seus índices UMA VEZ, de forma síncrona,
 * no require do módulo — não dá pra fazer uma query ao Postgres (async) no
 * meio dessa busca sem reescrever tudo pra async. Por isso o estoque vive
 * num Map em memória, recarregado do banco periodicamente (ver
 * `carregarEstoque` chamado em src/server.js): `obterEstoque(codigo)` é
 * síncrono e nunca bloqueia uma busca — só pode ficar levemente
 * desatualizado entre uma recarga e outra (aceitável: o CSV em si só
 * atualiza 1x/dia via Rotina).
 */
'use strict';

const fs = require('fs');
const pool = require('../database/postgres');
const logger = require('../utils/logger');

// ─── Parsing do CSV (puro — sem I/O, testável sem banco) ──────────────────

// Tokenizador CSV genérico (delimitador ';', aspas duplas com escape "" —
// o cabeçalho do relatório do X2 usa aspas com quebra de linha embutida,
// ex: "Preço Venda\nVarejo", então um split(';') ingênuo por linha quebraria
// bem no cabeçalho. As linhas de dados não têm aspas, mas parsear tudo com
// o mesmo tokenizador evita duas lógicas diferentes.
function _tokenizarCsv(conteudo) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroAspas = false;
  const texto = conteudo.replace(/^\uFEFF/, ''); // remove BOM se existir

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else {
        campo += c;
      }
      continue;
    }
    if (c === '"') { dentroAspas = true; continue; }
    if (c === ';') { linha.push(campo); campo = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') {
      linha.push(campo);
      campo = '';
      // ignora linha totalmente vazia (ex: linha em branco no fim do arquivo)
      if (!(linha.length === 1 && linha[0] === '')) linhas.push(linha);
      linha = [];
      continue;
    }
    campo += c;
  }
  // última linha sem \n final
  if (campo !== '' || linha.length) {
    linha.push(campo);
    if (!(linha.length === 1 && linha[0] === '')) linhas.push(linha);
  }
  return linhas;
}

function _normalizarCabecalho(texto) {
  return String(texto || '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

// "R$ 1.234,56" -> 1234.56 | "10,00" -> 10 | "" -> null
function _paraNumero(texto) {
  if (texto === undefined || texto === null) return null;
  const limpo = String(texto).replace(/R\$/g, '').trim();
  if (!limpo) return null;
  const semMilhar = limpo.replace(/\./g, '').replace(',', '.');
  const n = Number(semMilhar);
  return Number.isFinite(n) ? n : null;
}

function _normalizarCodigo(codigo) {
  return String(codigo || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Parseia o CSV do Relatório de Estoque (exportado por
 * x2-estoque-export.js) e retorna uma lista de registros prontos pra
 * upsert. Função pura — não toca em arquivo nem banco, só testa a lógica
 * de parsing isolada.
 */
function parseCsvEstoque(conteudo) {
  const linhas = _tokenizarCsv(conteudo);
  if (linhas.length < 2) return [];

  const cabecalho = linhas[0].map(_normalizarCabecalho);
  const idx = (nomeParcial) => cabecalho.findIndex((c) => c.includes(nomeParcial));

  const iCodigo = idx('CODIGO');
  const iCodFornecedor = idx('COD. FORNECEDOR') !== -1 ? idx('COD. FORNECEDOR') : idx('FORNECEDOR');
  const iDescricao = idx('DESCRICAO');
  const iQtd = idx('QTD ESTOQUE');
  const iUnd = idx('UND');
  const iCustoMedio = idx('CUSTO MEDIO');
  const iVarejo = idx('VAREJO');
  const iAtacado = idx('ATACADO');

  if (iCodigo === -1 || iQtd === -1) {
    throw new Error(
      `CSV de estoque não tem as colunas esperadas (Código / Qtd Estoque) — cabeçalho lido: ${cabecalho.join(' | ')}`
    );
  }

  const registros = [];
  for (let l = 1; l < linhas.length; l++) {
    const linha = linhas[l];
    const codigo = _normalizarCodigo(linha[iCodigo]);
    if (!codigo) continue;

    registros.push({
      codigo,
      codFornecedor: iCodFornecedor !== -1 ? (linha[iCodFornecedor] || '').trim() || null : null,
      descricao: iDescricao !== -1 ? (linha[iDescricao] || '').trim() || null : null,
      qtdEstoque: _paraNumero(linha[iQtd]) || 0,
      unidade: iUnd !== -1 ? (linha[iUnd] || '').trim() || null : null,
      custoMedio: iCustoMedio !== -1 ? _paraNumero(linha[iCustoMedio]) : null,
      precoVendaVarejo: iVarejo !== -1 ? _paraNumero(linha[iVarejo]) : null,
      precoVendaAtacado: iAtacado !== -1 ? _paraNumero(linha[iAtacado]) : null,
    });
  }
  return registros;
}

// ─── Import pro Postgres (só deve rodar DENTRO do container — ver aviso no
// topo do arquivo) ──────────────────────────────────────────────────────

const TAMANHO_LOTE = 500;

async function _upsertLote(client, registros) {
  if (!registros.length) return;
  const colunas = ['codigo', 'descricao', 'qtd_estoque', 'unidade', 'custo_medio', 'preco_venda_varejo', 'preco_venda_atacado'];
  const valores = [];
  const placeholders = registros.map((r, i) => {
    const base = i * colunas.length;
    valores.push(r.codigo, r.descricao, r.qtdEstoque, r.unidade, r.custoMedio, r.precoVendaVarejo, r.precoVendaAtacado);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, NOW(), NOW())`;
  });
  // criado_em só entra no INSERT (NOW() literal na posição certa) — de
  // propósito NÃO aparece no ON CONFLICT DO UPDATE abaixo, pra manter a
  // data da 1ª vez que o código apareceu num CSV mesmo depois de vários
  // reimports (pedido do usuário 2026-08-07: "lista de lançamentos
  // semanais de produtos que chegam" — precisa saber quando cada produto
  // apareceu pela primeira vez, não só o estado mais recente).
  const sql = `
    INSERT INTO estoque_produtos (codigo, descricao, qtd_estoque, unidade, custo_medio, preco_venda_varejo, preco_venda_atacado, criado_em, atualizado_em)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (codigo) DO UPDATE SET
      descricao = EXCLUDED.descricao,
      qtd_estoque = EXCLUDED.qtd_estoque,
      unidade = EXCLUDED.unidade,
      custo_medio = EXCLUDED.custo_medio,
      preco_venda_varejo = EXCLUDED.preco_venda_varejo,
      preco_venda_atacado = EXCLUDED.preco_venda_atacado,
      atualizado_em = EXCLUDED.atualizado_em
  `;
  await client.query(sql, valores);
}

// Empresas/unidades do X2 ("Relatório de Estoque Multiempresas"). MATRIZ é a
// "RILDON ELETROPECAS LTDA"; DIST e EC têm o sufixo (DIST)/(EC) no X2.
const EMPRESAS = ['MATRIZ', 'DIST', 'EC'];
const NOMES_EMPRESA = { MATRIZ: 'Matriz', DIST: 'Distribuidora', EC: 'Ecommerce' };

function normalizarEmpresa(valor) {
  const v = String(valor || '').trim().toUpperCase();
  return EMPRESAS.includes(v) ? v : null;
}

// Mesma regra de sempre (auditoria 2026-09-30): código que some do CSV mantinha
// a última quantidade para sempre. Zera a quantidade de quem não veio neste CSV
// (o upsert carimba NOW(); NOW() é fixo na transação). Trava: só se o CSV cobrir
// >= 80% dos produtos já cadastrados, pra um export parcial não zerar tudo.
async function _zerarAusentes(client, tabela, filtroEmpresa, qtdRegistros, rotulo) {
  const where = filtroEmpresa ? 'empresa = $1 AND ' : '';
  const params = filtroEmpresa ? [filtroEmpresa] : [];
  const { rows: [cont] } = await client.query(`SELECT COUNT(*)::int AS n FROM ${tabela} WHERE ${where}atualizado_em < NOW()`, params);
  const { rows: [tot] } = await client.query(`SELECT COUNT(*)::int AS n FROM ${tabela}${filtroEmpresa ? ' WHERE empresa = $1' : ''}`, params);
  if (tot.n > 0 && qtdRegistros >= tot.n * 0.8 && cont.n > 0) {
    const r = await client.query(`UPDATE ${tabela} SET qtd_estoque = 0 WHERE ${where}atualizado_em < NOW() AND qtd_estoque <> 0`, params);
    if (r.rowCount) logger.info(`[estoque.service] ${rotulo}: ${r.rowCount} produto(s) ausentes do CSV tiveram a quantidade zerada`);
  } else if (cont.n > 0) {
    logger.warn(`[estoque.service] ${rotulo}: CSV cobre só ${qtdRegistros} de ${tot.n} produtos — quantidades de ausentes NÃO foram zeradas (export parcial?)`);
  }
}

async function _upsertLoteUnidade(client, registros, empresa) {
  if (!registros.length) return;
  const valores = [];
  const placeholders = registros.map((r, i) => {
    const base = i * 5;
    valores.push(r.codigo, empresa, r.qtdEstoque, r.precoVendaVarejo, r.precoVendaAtacado);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, NOW())`;
  });
  await client.query(`
    INSERT INTO estoque_produtos_unidade (codigo, empresa, qtd_estoque, preco_venda_varejo, preco_venda_atacado, atualizado_em)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (codigo, empresa) DO UPDATE SET
      qtd_estoque = EXCLUDED.qtd_estoque,
      preco_venda_varejo = EXCLUDED.preco_venda_varejo,
      preco_venda_atacado = EXCLUDED.preco_venda_atacado,
      atualizado_em = EXCLUDED.atualizado_em
  `, valores);
}

/**
 * Lê o CSV do caminho informado, parseia e faz upsert.
 *  - sem `empresa`: comportamento de sempre — só estoque_produtos (relatório
 *    simples, Matriz).
 *  - com `empresa` (MATRIZ | DIST | EC, CSV do Relatório de Estoque
 *    Multiempresas): grava em estoque_produtos_unidade; a MATRIZ continua
 *    alimentando também estoque_produtos (descrição, custo, criado_em usados por
 *    Lançamentos). O CSV precisa ser "Com e sem estoque" — a trava de 80% só
 *    zera ausentes quando o arquivo cobre quase todos os produtos.
 * Roda em lotes dentro de uma transação. Retorna { total, arquivo, empresa }.
 */
async function importarCsv(caminhoArquivo, { empresa } = {}) {
  const empresaNorm = empresa === undefined || empresa === null || empresa === '' ? null : normalizarEmpresa(empresa);
  if (empresa && !empresaNorm) {
    throw new Error(`Empresa inválida "${empresa}" — use ${EMPRESAS.join(', ')}.`);
  }
  const conteudo = fs.readFileSync(caminhoArquivo, 'utf8');
  const registros = parseCsvEstoque(conteudo);
  if (!registros.length) {
    throw new Error(`Nenhum registro válido encontrado em ${caminhoArquivo}.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!empresaNorm || empresaNorm === 'MATRIZ') {
      for (let i = 0; i < registros.length; i += TAMANHO_LOTE) {
        await _upsertLote(client, registros.slice(i, i + TAMANHO_LOTE));
      }
      await _zerarAusentes(client, 'estoque_produtos', null, registros.length, 'estoque_produtos');
    }
    if (empresaNorm) {
      for (let i = 0; i < registros.length; i += TAMANHO_LOTE) {
        await _upsertLoteUnidade(client, registros.slice(i, i + TAMANHO_LOTE), empresaNorm);
      }
      await _zerarAusentes(client, 'estoque_produtos_unidade', empresaNorm, registros.length, `unidade ${empresaNorm}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  logger.info(`[estoque.service] importados ${registros.length} produtos de ${caminhoArquivo}${empresaNorm ? ` (empresa ${empresaNorm})` : ''}`);
  return { total: registros.length, arquivo: caminhoArquivo, empresa: empresaNorm };
}

// ─── Cache em memória (lido pelo catalogo-x2.service.js) ───────────────────

// codigoNormalizado -> { qtdEstoque, unidade, custoMedio, precoVendaVarejo, precoVendaAtacado,
//   atualizadoEm, qtdTotal, unidades }. `qtdEstoque` e os preços continuam sendo os da
//   Matriz (relatório simples); `qtdTotal` soma as unidades quando há dado por unidade
//   (senão é igual a qtdEstoque) e `unidades` é null sem dado por unidade.
let mapaEstoque = new Map();
let carregadoEm = null;

async function carregarEstoque() {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, descricao, qtd_estoque, unidade, custo_medio, preco_venda_varejo, preco_venda_atacado, atualizado_em
       FROM estoque_produtos`
    );
    const novoMapa = new Map();
    for (const r of rows) {
      novoMapa.set(_normalizarCodigo(r.codigo), {
        descricao: r.descricao || null,
        qtdEstoque: Number(r.qtd_estoque),
        unidade: r.unidade,
        custoMedio: r.custo_medio !== null ? Number(r.custo_medio) : null,
        precoVendaVarejo: r.preco_venda_varejo !== null ? Number(r.preco_venda_varejo) : null,
        precoVendaAtacado: r.preco_venda_atacado !== null ? Number(r.preco_venda_atacado) : null,
        atualizadoEm: r.atualizado_em,
      });
    }
    await _anexarUnidades(novoMapa);
    mapaEstoque = novoMapa;
    carregadoEm = new Date();
    logger.info(`[estoque.service] cache de estoque carregado: ${mapaEstoque.size} produtos.`);
  } catch (err) {
    // Não derruba o servidor por causa disso — tabela pode não existir ainda
    // (migration não aplicada) ou banco momentaneamente indisponível. Busca
    // do Catálogo continua funcionando normalmente, só sem o badge de estoque.
    logger.warn(`[estoque.service] falha ao carregar cache de estoque: ${err.message}`);
  }
}

// Soma e monta o detalhe por unidade a partir das linhas de estoque_produtos_unidade.
// Função pura (testável sem banco). Mutação do mapa: acrescenta qtdTotal/unidades em
// toda entrada e cria entrada para código que só existe numa unidade.
function combinarUnidades(mapa, linhasUnidade) {
  const porCodigo = new Map();
  for (const r of linhasUnidade) {
    const empresa = normalizarEmpresa(r.empresa);
    if (!empresa) continue;
    const codigo = _normalizarCodigo(r.codigo);
    if (!porCodigo.has(codigo)) porCodigo.set(codigo, {});
    porCodigo.get(codigo)[empresa] = {
      qtd: Number(r.qtd_estoque) || 0,
      precoVarejo: r.preco_venda_varejo !== null && r.preco_venda_varejo !== undefined ? Number(r.preco_venda_varejo) : null,
      precoAtacado: r.preco_venda_atacado !== null && r.preco_venda_atacado !== undefined ? Number(r.preco_venda_atacado) : null,
    };
  }
  for (const [codigo, porEmpresa] of porCodigo) {
    let entrada = mapa.get(codigo);
    if (!entrada) {
      const m = porEmpresa.MATRIZ;
      entrada = {
        descricao: null, qtdEstoque: m ? m.qtd : 0, unidade: null, custoMedio: null,
        precoVendaVarejo: m ? m.precoVarejo : null, precoVendaAtacado: m ? m.precoAtacado : null, atualizadoEm: null,
      };
      mapa.set(codigo, entrada);
    }
    entrada.unidades = EMPRESAS.filter((e) => porEmpresa[e]).map((e) => ({ empresa: e, nome: NOMES_EMPRESA[e], ...porEmpresa[e] }));
    entrada.qtdTotal = entrada.unidades.reduce((soma, u) => soma + u.qtd, 0);
  }
  for (const entrada of mapa.values()) {
    if (entrada.qtdTotal === undefined) { entrada.qtdTotal = entrada.qtdEstoque; entrada.unidades = null; }
  }
  return mapa;
}

async function _anexarUnidades(mapa) {
  let linhas = [];
  try {
    ({ rows: linhas } = await pool.query(
      'SELECT codigo, empresa, qtd_estoque, preco_venda_varejo, preco_venda_atacado FROM estoque_produtos_unidade'
    ));
  } catch (err) {
    // Migration 005 ainda não aplicada: segue só com o estoque da Matriz (comportamento antigo).
    logger.warn(`[estoque.service] estoque por unidade indisponível (${err.message}) — usando só a Matriz.`);
  }
  combinarUnidades(mapa, linhas);
}

/** Leitura síncrona do cache — nunca bloqueia uma busca do Catálogo. */
function obterEstoque(codigo) {
  return mapaEstoque.get(_normalizarCodigo(codigo)) || null;
}

function statusCache() {
  return { produtos: mapaEstoque.size, carregadoEm };
}

module.exports = {
  EMPRESAS,
  normalizarEmpresa,
  combinarUnidades,
  parseCsvEstoque,
  importarCsv,
  carregarEstoque,
  obterEstoque,
  statusCache,
};
