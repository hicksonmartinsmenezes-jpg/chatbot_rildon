-- Migration 020: remove 'crediario' do check de tickets.sector
-- Aplicar com: psql -U <user> -d <db> -f migrations/020_remove_crediario_sector.sql
--
-- Decisão do usuário (2026-07-24): a opção "Crediário" saiu do menu
-- principal do bot e o recurso foi descontinuado por completo (fluxo,
-- intenção da IA, submenu) — quem pede crediário agora é direcionado pro
-- telefone direto do setor (ver MSG.outrosContatos.LISTA em
-- src/flows/messages.js), igual Garantia/RH/Ouvidoria.
--
-- Seguro de aplicar: confirmado ANTES desta migration que não existe
-- nenhum ticket com sector='crediario' em produção (checado via
-- GET /api/tickets — 0 resultados). Se isso mudar entre a checagem e a
-- aplicação desta migration, o ALTER TABLE abaixo falha com violação de
-- CHECK constraint em vez de corromper dados — rode a query abaixo antes
-- de aplicar, por segurança:
--   SELECT id, protocolo FROM tickets WHERE sector = 'crediario';

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
