-- Migration 029: estoque_produtos_unidade — estoque e preço por empresa/unidade
-- (MATRIZ, DIST, EC) vindos do "Relatório de Estoque Multiempresas" do X2.
--
-- Por quê: estoque_produtos guarda uma quantidade só (a da Matriz, do relatório
-- simples). Produto que está só na Distribuidora aparecia como "Sem estoque" e
-- com o preço da Matriz (ex.: 123983, 13 na Distribuidora, 0 na Matriz).
-- estoque_produtos continua como está (Matriz + descrição/custo/criado_em para
-- Lançamentos); esta tabela só acrescenta a dimensão de unidade.
--
-- Idempotente: só cria tabela/índice se não existirem, não toca em dado existente.

CREATE TABLE IF NOT EXISTS estoque_produtos_unidade (
  codigo               TEXT          NOT NULL,
  empresa              VARCHAR(10)   NOT NULL,
  qtd_estoque          NUMERIC(12,2) NOT NULL DEFAULT 0,
  preco_venda_varejo   NUMERIC(12,2),
  preco_venda_atacado  NUMERIC(12,2),
  atualizado_em        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (codigo, empresa),
  CONSTRAINT estoque_produtos_unidade_empresa_chk CHECK (empresa IN ('MATRIZ', 'DIST', 'EC'))
);

CREATE INDEX IF NOT EXISTS idx_estoque_produtos_unidade_atualizado
  ON estoque_produtos_unidade (empresa, atualizado_em);
