-- Migration 012: índices faltando em history e tickets
--
-- Achados numa varredura de performance: o painel de Conversas consulta
-- GET /api/history/conversations a cada 30s (enquanto a aba estiver aberta),
-- rodando "SELECT DISTINCT ON (user_id) ... ORDER BY user_id, created_at DESC"
-- sobre a tabela history inteira. Sem um índice composto (user_id, created_at),
-- o Postgres não consegue resolver essa ordenação de forma eficiente e cai em
-- sort completo — o custo cresce junto com o histórico, que é logado a cada
-- interação do bot.
--
-- O mesmo padrão existe em tickets: toda listagem ordena por
-- "created_at DESC" (com ou sem filtro de data), mas não havia índice em
-- created_at — só em user_id, status, protocolo, sector, assigned_to_name e cpf.
--
-- Nenhuma mudança de comportamento, só de performance conforme os dados crescem.
CREATE INDEX IF NOT EXISTS idx_history_user_created ON history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at DESC);
