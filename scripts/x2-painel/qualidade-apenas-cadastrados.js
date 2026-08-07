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

/** CSV de estoque mais recente já baixado (qualquer opção de filtro usada
 * no download). `carregarExports()` já vem ordenado do mais novo pro mais
 * velho — ver x2-estoque-export.js. */
function _ultimoCsv() {
  const exports = carregarExports();
  return exports.length ? exports[0] : null;
}

/** Calcula a lista "Apenas Cadastrados" a partir do último CSV de estoque
 * baixado (lê o arquivo de verdade). Retorna null se nenhum CSV foi
 * baixado ainda (aba Estoque nunca usada) — quem chama decide como
 * comunicar isso (ver rota em server.js). */
function calcularApenasCadastrados() {
  const ultimo = _ultimoCsv();
  if (!ultimo) return null;

  const caminho = path.join(ESTOQUE_DIR, ultimo.nome);
  const conteudo = fs.readFileSync(caminho, 'utf8');
  return calcularApenasCadastradosDeConteudo(conteudo, { origemArquivo: ultimo.nome, capturadoEm: ultimo.modificadoEm });
}

module.exports = { CHAVE, LABEL_BADGE, calcularApenasCadastradosDeConteudo, calcularApenasCadastrados };
