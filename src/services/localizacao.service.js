/**
 * localizacao.service.js — importa o resultado da busca de Endereçamento
 * (X2 ☰ > Logística > Localização de Produto) pra `localizacoes_produtos`.
 *
 * PEDIDO DO USUÁRIO (2026-11-09): nova aba "Localizar" no Lente Rildon,
 * automatizando em Playwright a busca que antes era feita manualmente
 * (`scripts/x2-localizacao-scraper.js`). Tabela ISOLADA (pedido explícito,
 * não uma coluna no cadastro de produto — ver migration 028).
 *
 * ─── Como o dado chega até aqui (mesmo padrão do Estoque) ────────────────
 * `scripts/x2-localizacao-scraper.js` roda no HOST (Windows, fora do
 * Docker — precisa de Chrome de verdade) e salva o resultado em JSON em
 * `~/.x2-rildon-scraper/localizacao/resultados.json`. Depois de salvar, ele
 * dispara `docker exec chatbot_rildon_app npm run importar-localizacao --
 * ...` — o PARSE e o INSERT no banco só acontecem DENTRO do container,
 * nunca no host (ver memória do projeto "Postgres duplicado na porta
 * 5432" — qualquer comando de banco direto no host Windows cai no
 * Postgres NATIVO errado, mesmo com .env correto). `scripts/
 * importar-localizacao.js` é o único ponto de entrada válido.
 *
 * Diferente do Estoque, aqui o scraper já escreve os dados PRONTOS (não
 * precisa re-parsear um CSV do X2) — o arquivo importado é um array de
 * `{ codigo, endereco, status, erro }`, um por produto pesquisado nesta
 * rodada. `importarJson` faz upsert em lote dentro de 1 transação, sem
 * zerar/tocar nos códigos que não vieram nesta rodada (ao contrário do
 * Estoque, aqui cada rodada processa só uma FATIA pendente da fila — ver
 * `obterCodigosPendentes` no scraper — nunca o catálogo inteiro de uma
 * vez, então "ausente desta rodada" não significa nada sobre o produto).
 */
'use strict';

const fs = require('fs');
const pool = require('../database/postgres');
const logger = require('../utils/logger');

const STATUS_VALIDOS = ['pendente', 'encontrado', 'sem_enderecamento', 'erro'];
const TAMANHO_LOTE = 500;

/** Validação pura (sem I/O) — um registro por produto pesquisado. */
function _normalizarRegistro(r) {
  const codigo = String(r.codigo || '').trim();
  if (!codigo) return null;
  const status = STATUS_VALIDOS.includes(r.status) ? r.status : 'erro';
  const endereco = typeof r.endereco === 'string' && r.endereco.trim() ? r.endereco.trim() : null;
  const erro = typeof r.erro === 'string' && r.erro.trim() ? r.erro.trim().slice(0, 500) : null;
  return { codigo, status, endereco, erro };
}

async function _upsertLote(client, registros) {
  if (!registros.length) return;
  const colunas = ['codigo', 'endereco', 'status', 'erro'];
  const valores = [];
  const placeholders = registros.map((r, i) => {
    const base = i * colunas.length;
    valores.push(r.codigo, r.endereco, r.status, r.erro);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, NOW())`;
  });
  const sql = `
    INSERT INTO localizacoes_produtos (codigo, endereco, status, erro, atualizado_em)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (codigo) DO UPDATE SET
      endereco = EXCLUDED.endereco,
      status = EXCLUDED.status,
      erro = EXCLUDED.erro,
      atualizado_em = EXCLUDED.atualizado_em
  `;
  await client.query(sql, valores);
}

/**
 * Lê o JSON do caminho informado (array de {codigo, endereco, status,
 * erro}), parseia e faz upsert em localizacoes_produtos. Roda em lotes
 * dentro de uma transação. Retorna { total, arquivo }.
 */
async function importarJson(caminhoArquivo) {
  const conteudo = fs.readFileSync(caminhoArquivo, 'utf8');
  const bruto = JSON.parse(conteudo);
  if (!Array.isArray(bruto)) {
    throw new Error(`${caminhoArquivo} não é um array JSON de resultados.`);
  }
  const registros = bruto.map(_normalizarRegistro).filter(Boolean);
  if (!registros.length) {
    throw new Error(`Nenhum registro válido encontrado em ${caminhoArquivo}.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < registros.length; i += TAMANHO_LOTE) {
      await _upsertLote(client, registros.slice(i, i + TAMANHO_LOTE));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  logger.info(`[localizacao.service] importados ${registros.length} resultado(s) de ${caminhoArquivo}`);
  return { total: registros.length, arquivo: caminhoArquivo };
}

module.exports = {
  STATUS_VALIDOS,
  _normalizarRegistro,
  importarJson,
};
