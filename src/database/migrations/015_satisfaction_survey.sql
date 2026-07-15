-- Migration 015: pesquisa de satisfação ao fechar atendimento
-- Aplicar com: psql -U <user> -d <db> -f migrations/015_satisfaction_survey.sql
--
-- Pedido do usuário: quando um ticket é fechado (resolvido), o cliente
-- recebe automaticamente uma mensagem (pelo mesmo número do bot) pedindo
-- pra avaliar de 1 a 5. satisfaction_asked_at marca "pesquisa pendente"
-- até o cliente responder (ou expirar, ver janela em message.service.js) —
-- não precisa de tabela nova, o próprio ticket carrega o estado.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS satisfaction_rating   SMALLINT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS satisfaction_asked_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS satisfaction_rated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ticket_satisfaction_rating'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT chk_ticket_satisfaction_rating
      CHECK (satisfaction_rating IS NULL OR satisfaction_rating BETWEEN 1 AND 5);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_tickets_satisfaction_rating ON tickets(satisfaction_rating);
