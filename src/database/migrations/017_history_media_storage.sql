-- Migration 017: guarda o arquivo de mídia recebida (foto/áudio/vídeo/sticker/
-- documento) do cliente, não só o rótulo "[tipo recebido]".
-- Aplicar com: node src/database/migrate.js  (ou psql -U <user> -d <db> -f migrations/017_history_media_storage.sql)
--
-- Pedido do usuário (2026-07-20): "verifique por que arquivos de mídia e
-- áudio não aparecem no meu painel de atendimento". Resposta encontrada no
-- código: decisão deliberada de uma correção anterior (ver comentário em
-- config/whatsapp.js, task #116) — o bot nunca salvava o arquivo em disco,
-- só o fato de ter chegado. Essas 3 colunas guardam o suficiente pra servir
-- o arquivo de volta pro painel: media_path (nome do arquivo salvo em
-- src/media-recebida/, NUNCA o caminho completo do disco — evita vazar
-- estrutura de diretório do servidor), media_mimetype (define como o
-- painel renderiza: <img>, <audio>, <video> ou link de download) e
-- media_filename (nome original, só relevante pra documentos).
ALTER TABLE history ADD COLUMN IF NOT EXISTS media_path      TEXT;
ALTER TABLE history ADD COLUMN IF NOT EXISTS media_mimetype  TEXT;
ALTER TABLE history ADD COLUMN IF NOT EXISTS media_filename  TEXT;
