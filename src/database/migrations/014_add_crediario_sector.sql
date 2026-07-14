-- Migration 014: adiciona 'crediario' ao check de tickets.sector
-- Aplicar com: psql -U <user> -d <db> -f migrations/014_add_crediario_sector.sql
--
-- A migration 004 já tinha corrigido esse mesmo problema pra 'gestao', mas
-- "crediario" (usado em SETORES_VALIDOS no ticket.controller.js e no fluxo
-- src/flows/crediario.flow.js) nunca foi adicionado à constraint — qualquer
-- transferência de ticket para o setor "crediario" falha com violação de
-- CHECK constraint (erro 500), mesmo sendo um valor aceito pela validação
-- da aplicação.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_ticket_sector'
  ) THEN
    ALTER TABLE tickets DROP CONSTRAINT chk_ticket_sector;
  END IF;

  ALTER TABLE tickets
    ADD CONSTRAINT chk_ticket_sector
    CHECK (sector IN ('suporte','vendas','financeiro','garantia','geral','atendimento','gestao','crediario'));
END$$;
