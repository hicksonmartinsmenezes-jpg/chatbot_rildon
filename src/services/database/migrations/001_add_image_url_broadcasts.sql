-- Migração 001: adiciona coluna image_url na tabela broadcasts
-- (estava faltando no schema original mas usada no broadcast.service.js)
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS image_url TEXT;
