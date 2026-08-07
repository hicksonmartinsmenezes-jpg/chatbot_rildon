#!/usr/bin/env node
/**
 * scripts/x2-painel/lancamentos.js
 *
 * PEDIDO DO USUÁRIO (2026-08-07): "a ideia de capturar aquele csv é
 * capturar dados, ou seja, produtos novos cadastrados... é mais fácil do
 * que sair fazendo varredura por tantos, e preciso que gere uma lista de
 * lançamentos semanais de produtos que chegam... deixe uma aba só pra
 * isso pra eu poder visualizar os produtos novos".
 *
 * Ideia: cada export do Relatório de Estoque (scripts/x2-estoque-export.js)
 * é um SNAPSHOT completo, salvo com data/hora no nome do arquivo
 * (`~/.x2-rildon-scraper/estoque/estoque-AAAA-MM-DD_HH-MM.csv`). Um
 * "lançamento" (produto novo) é um código que aparece pela 1ª vez num
 * snapshot mais recente, mas não existia em NENHUM snapshot anterior.
 *
 * 100% baseado em arquivo local, de propósito — diferente do "estoque ao
 * vivo no Catálogo" (essa outra feature, no app principal, grava em
 * Postgres via `docker exec`). Rodar isso pelo Painel Fotos X2 (que roda
 * no HOST, fora do Docker) não pode depender do banco — ver aviso em
 * src/services/estoque.service.js sobre o Postgres duplicado na porta
 * 5432. Reaproveita só a função PURA de parsing (parseCsvEstoque), que
 * não toca em banco nenhum.
 *
 * ⚠️ Limitação honesta: só existe "1ª vez visto" a partir de quando a
 * captura de CSVs começou de verdade (2026-08-06/07 em diante) — não tem
 * como reconstruir lançamentos de semanas anteriores a isso, porque não
 * existe snapshot de estoque de antes dessa data.
 *
 * ─── Cache ──────────────────────────────────────────────────────────────
 * Escanear e reparsear TODOS os CSVs a cada consulta ficaria mais lento
 * conforme o histórico cresce (1 CSV/dia, ~5.200 linhas cada). Por isso o
 * índice (`codigo -> primeira vez visto + dados do produto`) é calculado
 * uma vez e cacheado em `~/.x2-rildon-scraper/estoque/lancamentos-
 * indice.json`, invalidado só quando a LISTA de arquivos CSV muda (novo
 * export baixado) — comparado por nome+tamanho+mtime, não reprocessa à
 * toa.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCsvEstoque } = require('../../src/services/estoque.service');

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const ESTOQUE_DIR = path.join(WORK_DIR, 'estoque');
const INDICE_PATH = path.join(ESTOQUE_DIR, 'lancamentos-indice.json');

function _listarCsvsOrdenados() {
  if (!fs.existsSync(ESTOQUE_DIR)) return [];
  return fs.readdirSync(ESTOQUE_DIR)
    .filter((f) => f.endsWith('.csv'))
    .map((f) => {
      const caminho = path.join(ESTOQUE_DIR, f);
      const stat = fs.statSync(caminho);
      return { nome: f, caminho, tamanho: stat.size, mtimeMs: stat.mtimeMs };
    })
    // Data vem do NOME do arquivo (estoque-AAAA-MM-DD_HH-MM.csv), não do
    // mtime do arquivo — mtime muda se o arquivo for copiado/movido depois
    // (ex: pro handoff do docker), o nome não.
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

function _dataDoNomeArquivo(nomeArquivo) {
  // "estoque-2026-08-07_14-30.csv" -> Date
  const m = nomeArquivo.match(/estoque-(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, ano, mes, dia, hora, min] = m;
  return new Date(Number(ano), Number(mes) - 1, Number(dia), Number(hora), Number(min));
}

function _carregarIndiceCache() {
  if (!fs.existsSync(INDICE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(INDICE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function _salvarIndiceCache(indice) {
  fs.mkdirSync(ESTOQUE_DIR, { recursive: true });
  fs.writeFileSync(INDICE_PATH, JSON.stringify(indice, null, 2));
}

// Assinatura da lista de CSVs atual — muda se algum arquivo for
// adicionado/removido/alterado, invalidando o cache.
function _assinaturaArquivos(csvs) {
  return csvs.map((c) => `${c.nome}:${c.tamanho}`).join('|');
}

/**
 * Recalcula o índice completo lendo todos os CSVs em ordem cronológica.
 * Função pura o suficiente pra testar: recebe a lista de {nome, conteudo}
 * já lida (sem fs), retorna { assinatura, produtos: { [codigo]: {...} } }.
 */
function construirIndice(arquivos) {
  // arquivos: [{ nome, conteudo }], já deve vir em ordem cronológica
  const produtos = {}; // codigo -> { primeiraVez, arquivoOrigem, descricao, codFornecedor, custoMedio, precoVendaVarejo, precoVendaAtacado }

  for (const arquivo of arquivos) {
    const dataArquivo = _dataDoNomeArquivo(arquivo.nome);
    if (!dataArquivo) continue; // nome fora do padrão esperado — ignora, não quebra o índice inteiro
    let registros;
    try {
      registros = parseCsvEstoque(arquivo.conteudo);
    } catch {
      continue; // CSV corrompido/formato inesperado — pula esse arquivo, não trava o índice inteiro
    }
    for (const r of registros) {
      if (produtos[r.codigo]) continue; // já visto num arquivo anterior (mais antigo) — mantém a 1ª aparição
      produtos[r.codigo] = {
        codigo: r.codigo,
        primeiraVez: dataArquivo.toISOString(),
        arquivoOrigem: arquivo.nome,
        descricao: r.descricao,
        codFornecedor: r.codFornecedor,
        custoMedio: r.custoMedio,
        precoVendaVarejo: r.precoVendaVarejo,
        precoVendaAtacado: r.precoVendaAtacado,
      };
    }
  }

  return produtos;
}

/**
 * Garante que o índice está atualizado (recalcula só se a lista de CSVs
 * mudou desde o último cache) e retorna { produtos, totalArquivos,
 * primeiroArquivo, ultimoArquivo }.
 */
function obterIndiceAtualizado() {
  const csvs = _listarCsvsOrdenados();
  if (!csvs.length) {
    return { produtos: {}, totalArquivos: 0, primeiroArquivo: null, ultimoArquivo: null };
  }

  const assinaturaAtual = _assinaturaArquivos(csvs);
  const cache = _carregarIndiceCache();
  if (cache && cache.assinatura === assinaturaAtual) {
    return {
      produtos: cache.produtos,
      totalArquivos: csvs.length,
      primeiroArquivo: csvs[0].nome,
      ultimoArquivo: csvs[csvs.length - 1].nome,
    };
  }

  const arquivosComConteudo = csvs.map((c) => ({ nome: c.nome, conteudo: fs.readFileSync(c.caminho, 'utf8') }));
  const produtos = construirIndice(arquivosComConteudo);
  _salvarIndiceCache({ assinatura: assinaturaAtual, produtos, geradoEm: new Date().toISOString() });

  return {
    produtos,
    totalArquivos: csvs.length,
    primeiroArquivo: csvs[0].nome,
    ultimoArquivo: csvs[csvs.length - 1].nome,
  };
}

/**
 * Lista produtos cuja 1ª aparição caiu dentro de [desde, ate] (strings
 * "AAAA-MM-DD" ou Date). O snapshot mais ANTIGO de todos nunca conta como
 * "lançamento" de propósito — ele é a LINHA DE BASE (tudo que já existia
 * quando a captura começou), não dá pra saber se era novo ou não antes
 * disso.
 */
function listarLancamentos({ desde, ate } = {}) {
  const { produtos, totalArquivos, primeiroArquivo, ultimoArquivo } = obterIndiceAtualizado();

  if (totalArquivos < 2) {
    return {
      lancamentos: [],
      aviso: totalArquivos === 0
        ? 'Nenhum export de estoque encontrado ainda — rode "Exportar estoque" pelo menos 2 vezes (em dias diferentes) pra começar a detectar lançamentos.'
        : 'Só existe 1 export de estoque até agora (linha de base) — rode de novo em outro dia pra começar a detectar produtos novos.',
      totalArquivos,
      primeiroArquivo,
      ultimoArquivo,
    };
  }

  const dataBase = _dataDoNomeArquivo(primeiroArquivo);
  const desdeDate = desde ? new Date(desde) : null;
  const ateDate = ate ? new Date(new Date(ate).setHours(23, 59, 59, 999)) : null;

  const lancamentos = Object.values(produtos).filter((p) => {
    const dataP = new Date(p.primeiraVez);
    // nunca conta o snapshot-base inteiro como "lançamento"
    if (dataBase && dataP.getTime() === dataBase.getTime() && p.arquivoOrigem === primeiroArquivo) return false;
    if (desdeDate && dataP < desdeDate) return false;
    if (ateDate && dataP > ateDate) return false;
    return true;
  });

  lancamentos.sort((a, b) => new Date(b.primeiraVez) - new Date(a.primeiraVez));

  return { lancamentos, aviso: null, totalArquivos, primeiroArquivo, ultimoArquivo };
}

module.exports = {
  ESTOQUE_DIR,
  INDICE_PATH,
  construirIndice,
  obterIndiceAtualizado,
  listarLancamentos,
};
