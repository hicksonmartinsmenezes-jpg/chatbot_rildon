/**
 * scripts/x2-painel/qualidade-apenas-cadastrados.js
 *
 * PEDIDO DO USUÁRIO (2026-08-07): "a ideia de baixar aquele csv de todo
 * estoque com e sem, é porque lá tem tudo relacionado se tem estoque e
 * preços... itens que estão sem estoque e sem preço defina eles como
 * Apenas Cadastrados no painel de Qualidade Cadastral".
 *
 * Diferente das outras 4 listas de Qualidade Cadastral (Itens Inativos, Sem
 * Foto/Arquivo, Preço de Venda Zerado, Sem Custo Médio — ver
 * x2-painel-produtos-snapshot.js), que exigem abrir o navegador e clicar em
 * telas do X2, esta categoria é 100% CALCULADA a partir do CSV que a aba
 * Estoque já baixa ("Com e sem estoque" traz as duas colunas — estoque e
 * preço — na mesma linha, por isso essa é a opção recomendada pra essa
 * conta fechar certo). Não precisa de navegador nem de captura própria —
 * só lê o CSV mais recente já salvo em ~/.x2-rildon-scraper/estoque/.
 *
 * Critério (definido pelo usuário): Qtd Estoque = 0 E Preço Venda Varejo =
 * 0/vazio → produto só tem o cadastro básico, nada além disso → "Apenas
 * Cadastrados".
 *
 * Reaproveita `parseCsvEstoque` de src/services/estoque.service.js (mesmo
 * parser usado pra popular a tabela estoque_produtos) — sem duplicar lógica
 * de parsing de CSV. Requerer esse módulo aqui é seguro: `parseCsvEstoque`
 * é função pura (sem I/O), e o `pool` do Postgres que o arquivo importa por
 * baixo não abre conexão nenhuma só por ser importado (só ao chamar
 * `.query()`/`.connect()`, o que esta função nunca faz).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsvEstoque } = require('../../src/services/estoque.service');
const { ESTOQUE_DIR, carregarExports } = require('../x2-estoque-export');

const CHAVE = 'apenasCadastrados';
const LABEL_BADGE = 'Apenas Cadastrados';

function _metaDeExportCompleto(meta) {
  return Boolean(meta && meta.validado === true && meta.completo === true
    && meta.estoqueOpcao === 'Com e sem estoque' && Number.isFinite(Date.parse(meta.capturadoEm))
    && Number.isFinite(meta.linhasCsv) && meta.linhasCsv > 0
    && Number.isFinite(meta.linhasTabela) && meta.linhasTabela > 0);
}

function _semEstoqueESemPreco(registro) {
  const semEstoque = !registro.qtdEstoque || registro.qtdEstoque <= 0;
  const semPreco = !registro.precoVendaVarejo || registro.precoVendaVarejo <= 0;
  return semEstoque && semPreco;
}

const HEADERS = ['Código', 'Cód. Fornecedor', 'Descrição', 'Qtd Estoque', 'Preço Venda Varejo', 'Custo Médio'];

/** Lógica PURA (sem tocar em fs) — recebe o conteúdo de texto do CSV já lido
 * e monta a lista no mesmo formato {headers, produtos} das outras 4
 * divergências. Separada de `calcularApenasCadastrados()` só pra poder
 * testar sem precisar de arquivo real em disco (mesmo padrão de
 * tests/estoque.service.parseCsv.test.js / lancamentos.js). */
function calcularApenasCadastradosDeConteudo(conteudoCsv, { origemArquivo, capturadoEm }) {
  const registros = parseCsvEstoque(conteudoCsv);
  const filtrados = registros.filter(_semEstoqueESemPreco);

  const produtos = filtrados.map((r) => [
    r.codigo,
    r.codFornecedor || '',
    r.descricao || '',
    String(r.qtdEstoque || 0),
    r.precoVendaVarejo ? String(r.precoVendaVarejo) : '0',
    r.custoMedio !== null && r.custoMedio !== undefined ? String(r.custoMedio) : '',
  ]);

  return {
    chave: CHAVE,
    labelBadge: LABEL_BADGE,
    capturadoEm,
    origemArquivo,
    headers: HEADERS,
    produtos,
  };
}

function _lerExport(nome) {
  try {
    const caminho = path.join(ESTOQUE_DIR, nome);
    const conteudo = fs.readFileSync(caminho, 'utf8');
    const registros = parseCsvEstoque(conteudo);
    if (!registros.length) return null;
    let meta = null;
    const caminhoMeta = `${caminho}.meta.json`;
    if (fs.existsSync(caminhoMeta)) {
      try { meta = JSON.parse(fs.readFileSync(caminhoMeta, 'utf8')); } catch { return null; }
    }
    if (meta && (!_metaDeExportCompleto(meta)
      || registros.length < meta.linhasCsv * 0.9 || registros.length < meta.linhasTabela * 0.9)) return null;
    return { conteudo, registros, meta };
  } catch {
    return null;
  }
}

function _ultimoCsv() {
  const arquivos = carregarExports();
  const avaliados = arquivos.map((item) => ({ item, dados: _lerExport(item.nome) })).filter((x) => x.dados);
  // Arquivos legados sem proveniência de filtro são indeterminados; até uma
  // nova captura full com sidecar explícito, não são fonte verificada.
  return avaliados.find(({ dados }) => Boolean(dados.meta)) || null;
}

/** Calcula a lista apenas a partir de um CSV com metadados explícitos de
 * export completo. Retorna null quando ainda não há fonte verificada. */
function calcularApenasCadastrados() {
  const selecionado = _ultimoCsv();
  if (!selecionado) return null;
  return calcularApenasCadastradosDeConteudo(selecionado.dados.conteudo, {
    origemArquivo: selecionado.item.nome,
    capturadoEm: selecionado.item.modificadoEm,
  });
}

module.exports = { CHAVE, LABEL_BADGE, calcularApenasCadastradosDeConteudo, calcularApenasCadastrados, metaDeExportCompleto: _metaDeExportCompleto };
