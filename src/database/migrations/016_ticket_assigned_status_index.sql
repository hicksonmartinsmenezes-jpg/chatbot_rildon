-- Migration 016: índice composto pra consulta de "tickets em_andamento por atendente"
-- Aplicar com: psql -U <user> -d <db> -f migrations/016_ticket_assigned_status_index.sql
--
-- Pedido do usuário: painel Usuários agora mostra quem está "em
-- atendimento" (GET /api/users faz "WHERE status='em_andamento' AND
-- assigned_to IS NOT NULL GROUP BY assigned_to" a cada carregamento da
-- lista). Não existia índice cobrindo assigned_to — só idx_tickets_status
-- (status sozinho) e idx_tickets_assigned_name (assigned_to_name, não
-- assigned_to). Índice composto (status, assigned_to) atende exatamente
-- o padrão WHERE status = X AND assigned_to IS NOT NULL GROUP BY assigned_to.

CREATE INDEX IF NOT EXISTS idx_tickets_status_assigned_to ON tickets(status, assigned_to);
