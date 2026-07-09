-- Migration 013: índices faltando em contacts (tags, atendente_id)
--
-- listContacts (contacts.service.js) filtra por tag via "$1 = ANY(tags)"
-- sem nenhum índice em tags — cada filtro de tag varre a tabela inteira.
-- Como tags é um array (TEXT[]), o índice adequado é GIN, não btree.
--
-- atendente_id é usado tanto em filtro direto (listContacts) quanto em JOIN
-- (listContacts, getContact) e em getBroadcastAudience (tipo "contacts" com
-- atendenteId) — não tinha índice nenhum.
--
-- Nenhuma mudança de comportamento, só de performance conforme a base de
-- contatos cresce.
CREATE INDEX IF NOT EXISTS idx_contacts_tags ON contacts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_contacts_atendente ON contacts(atendente_id);
