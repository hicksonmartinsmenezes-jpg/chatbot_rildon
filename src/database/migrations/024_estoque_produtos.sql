-- Migration 024: estoque_produtos — snapshot de estoque do X2, atualizado
-- por scripts/x2-estoque-export.js (roda no host, fora do Docker) via
-- scripts/importar-estoque.js (roda DENTRO do container, ver aviso abaixo).
-- Aplicar com: psql -U <user> -d <db> -f migrations/024_estoque_produtos.sql
--
-- Pedido do usuário (2026-08-07): "Estoque ao vivo no Catálogo/orçamento" —
-- mostrar "X em estoque"/"Sem estoque" na busca do Catálogo do painel,
-- usando o CSV do Relatório de Estoque do X2 (já confirmado funcionando
-- via x2-estoque-export.js, ver memória do projeto).
--
-- Por que uma tabela nova (não um campo dentro de src/config/catalogo-x2/
-- *.json): o catálogo (17.417 produtos, JSON estático extraído 1x) e o
-- estoque (5.224 produtos, muda todo dia) têm ciclo de vida DIFERENTE —
-- reescrever os 26 JSONs do catálogo a cada snapshot de estoque seria
-- lento e arriscaria corromper o catálogo por um problema no CSV de
-- estoque. `codigo` é a chave de junção — bate 1:1 com o campo `codigo`
-- do catálogo (confirmado: mesmo "Código" interno do X2 nos dois lados).
--
-- ⚠️ IMPORTANTE (ver memória "Postgres duplicado na porta 5432"): esta
-- tabela só deve ser populada via `docker exec chatbot_rildon_app npm run
-- importar-estoque -- <caminho>` — NUNCA rodando o import direto no host
-- Windows, que cairia no Postgres nativo errado (mesmo com .env
-- "correto").
--
-- Seguro de aplicar: só cria tabela nova, não toca em nada existente.

CREATE TABLE IF NOT EXISTS estoque_produtos (
  codigo               TEXT PRIMARY KEY,
  qtd_estoque          NUMERIC(12,2) NOT NULL DEFAULT 0,
  unidade              VARCHAR(10),
  custo_medio          NUMERIC(12,2),
  preco_venda_varejo   NUMERIC(12,2),
  preco_venda_atacado  NUMERIC(12,2),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_estoque_produtos_atualizado
  ON estoque_produtos (atualizado_em);
