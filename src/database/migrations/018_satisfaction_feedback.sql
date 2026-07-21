-- Migration 018: campo livre "o que podemos melhorar" na pesquisa de satisfação
-- Aplicar com: psql -U <user> -d <db> -f migrations/018_satisfaction_feedback.sql
--
-- Pedido do usuário: quando o cliente dá nota baixa (1 ou 2, ver
-- SATISFACTION_LOW_THRESHOLD em ticket.service.js) na pesquisa de
-- satisfação (migration 015), o bot pergunta em seguida "o que podemos
-- melhorar?" antes do agradecimento final. A resposta livre do cliente
-- fica registrada aqui, no próprio ticket — mesmo padrão de
-- satisfaction_rating (sem tabela nova).

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS satisfaction_feedback    TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS satisfaction_feedback_at TIMESTAMPTZ;
