-- Migration 021: renomeia a tag automática "Clientes Novos" para "Leads"
-- Aplicar com: psql -U <user> -d <db> -f migrations/021_rename_leads_tag.sql
--
-- Pedido do usuário (2026-07-31): "Clientes Novos" dava a entender "cliente
-- recém-chegado", mas na real é "contato que só passou pelo bot e nunca
-- gerou um ticket de verdade" (ver TAG_CLIENTE_NOVO em contacts.service.js,
-- marcarComoCliente). "Leads" descreve isso sem ambiguidade. A constante no
-- código já foi trocada — esta migration só corrige os contatos que JÁ
-- tinham a tag antiga gravada no array `tags`, senão eles ficariam presos
-- com o nome velho pra sempre (o código novo só decide o nome de contatos
-- NOVOS a partir de agora).
--
-- Seguro de aplicar: só troca o texto da tag dentro do array (array_replace),
-- não mexe em nenhum outro campo nem cria/apaga contato.

UPDATE contacts
SET tags = array_replace(tags, 'Clientes Novos', 'Leads'),
    updated_at = NOW()
WHERE 'Clientes Novos' = ANY(tags);
