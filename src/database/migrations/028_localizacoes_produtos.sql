-- PEDIDO DO USUÁRIO (2026-11-09): aba nova "Localizar" no Lente Rildon,
-- automatizando em Playwright a busca de Endereçamento (tela X2 ☰ >
-- Logística > Localização de Produto) que antes era feita manualmente
-- produto por produto. Escopo combinado com o usuário: só produtos SEM
-- FOTO e COM ESTOQUE (> 0) — mesmo filtro da lista manual já entregue
-- (produtos-sem-foto-com-estoque-localizacao.xlsx) — e só reprocessa
-- código ainda PENDENTE (nunca refaz um código já resolvido).
--
-- Tabela ISOLADA de propósito (pedido explícito do usuário: "nova tabela
-- isolada, não quero uma coluna no cadastro de produto existente") — ver
-- `estoque_produtos` (024_estoque_produtos.sql) pro mesmo padrão de
-- schema. `status` distingue "ainda não tentamos"/"tentamos e achou
-- endereço"/"tentamos e o X2 não tem endereço pra esse código"/"tentamos
-- e deu erro" — o scraper (scripts/x2-localizacao-scraper.js) só
-- reprocessa 'pendente' e 'erro', nunca 'encontrado'/'sem_enderecamento'.
CREATE TABLE IF NOT EXISTS localizacoes_produtos (
  codigo          TEXT PRIMARY KEY,
  -- Mais de 1 endereço (visto ao vivo no código 116680, na varredura
  -- manual) vem como texto único, separado por "; " — ver
  -- x2-localizacao-scraper.js. NULL enquanto pendente ou sem endereçamento.
  endereco        TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'encontrado', 'sem_enderecamento', 'erro')),
  -- Guarda a mensagem de erro da última tentativa (NULL fora do caso
  -- 'erro') — ajuda a diagnosticar sem precisar abrir o log da execução.
  erro            TEXT,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_localizacoes_produtos_status ON localizacoes_produtos (status);
