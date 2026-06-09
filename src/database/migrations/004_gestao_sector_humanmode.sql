-- Migration 004: adiciona 'gestao' ao check de sector e tabela de human_mode_sessions
-- Aplicar com: psql -U <user> -d <db> -f migrations/004_gestao_sector_humanmode.sql

-- 1. Recria CHECK CONSTRAINT de tickets.sector incluindo 'gestao'
--    (a constraint antiga não incluía 'gestao', causando falha ao criar tickets de gestão)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ticket_sector'
  ) THEN
    ALTER TABLE tickets DROP CONSTRAINT chk_ticket_sector;
  END IF;

  ALTER TABLE tickets
    ADD CONSTRAINT chk_ticket_sector
    CHECK (sector IN ('suporte','vendas','financeiro','garantia','geral','atendimento','gestao'));
END$$;

-- 2. Tabela para persistir sessões de atendimento humano entre restarts do servidor
--    Sem ela, um restart do container faz o bot voltar a responder clientes
--    que ainda estavam sendo atendidos por um humano.
CREATE TABLE IF NOT EXISTS human_mode_sessions (
  user_id          TEXT PRIMARY KEY,
  ticket_id        INTEGER,
  ticket_protocolo TEXT,
  agent_name       TEXT NOT NULL DEFAULT '',
  since            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
