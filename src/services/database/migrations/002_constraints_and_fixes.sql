-- Migration 002: constraints de integridade e correções de schema
-- Aplicar com: psql -U <user> -d <db> -f migrations/002_constraints_and_fixes.sql

-- 1. CHECK CONSTRAINT para tickets.status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ticket_status'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT chk_ticket_status
      CHECK (status IN ('aberto','em_andamento','resolvido','cancelado'));
  END IF;
END$$;

-- 2. CHECK CONSTRAINT para tickets.sector
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ticket_sector'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT chk_ticket_sector
      CHECK (sector IN ('suporte','vendas','financeiro','garantia','geral','atendimento'));
  END IF;
END$$;

-- 3. Corrige DEFAULT de history.status: string vazia → NULL (mais semântico)
ALTER TABLE history ALTER COLUMN status SET DEFAULT NULL;

-- Limpa registros existentes com string vazia (opcional, comente se preferir manter)
UPDATE history SET status = NULL WHERE status = '';

-- 4. Índice para busca por sector em tickets (melhora getTicketDashboard)
CREATE INDEX IF NOT EXISTS idx_tickets_sector ON tickets(sector);

-- 5. Índice para busca por assigned_to_name (melhora porAtendente no dashboard)
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_name ON tickets(assigned_to_name);
