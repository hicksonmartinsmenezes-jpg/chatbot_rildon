-- Migration 025: estoque_produtos.descricao + criado_em
-- Aplicar com: psql -U <user> -d <db> -f migrations/025_estoque_produtos_lancamentos.sql
--
-- Pedido do usuário (2026-08-07): "a ideia de capturar aquele csv é
-- capturar dados, ou seja, produtos novos cadastrados... preciso que gere
-- uma lista de lançamentos semanais de produtos que chegam". Duas colunas
-- novas na tabela criada pela migration 024:
--   - descricao: o CSV de estoque já traz a descrição do produto — útil
--     pra mostrar o nome de um produto NOVO que ainda nem está no catálogo
--     local (src/config/catalogo-x2/*.json só é atualizado por outra
--     rotina, pode estar desatualizado).
--   - criado_em: registra a 1ª vez que aquele código apareceu em algum
--     import — diferente de atualizado_em (que muda toda vez). O
--     ON CONFLICT DO UPDATE em estoque.service.js._upsertLote foi ajustado
--     pra NUNCA sobrescrever criado_em depois do 1º insert.
--
-- (A feature de "lançamentos" em si roda fora do Docker, direto do Painel
-- Fotos X2 — lê os CSVs salvos localmente, sem depender desta tabela. Estas
-- colunas servem só pra manter o "estoque ao vivo do Catálogo" completo.)
--
-- Seguro de aplicar: só adiciona colunas, não toca em dado existente.

ALTER TABLE estoque_produtos ADD COLUMN IF NOT EXISTS descricao TEXT;
ALTER TABLE estoque_produtos ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_estoque_produtos_criado
  ON estoque_produtos (criado_em);
