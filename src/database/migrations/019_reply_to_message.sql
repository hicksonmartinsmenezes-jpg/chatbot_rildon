-- Migration 019: suporte a "responder mensagem específica" (reply/quote,
-- igual o recurso nativo do WhatsApp).
-- Aplicar com: node src/database/migrate.js
--
-- Pedido do usuário (2026-07-23): reply/quote de uma mensagem específica do
-- cliente. quoted_message_id guarda o message_id (coluna já existente) da
-- mensagem citada; quoted_text guarda um recorte do texto citado — salvo
-- aqui mesmo (denormalizado) pra renderizar a prévia da citação no painel
-- sem precisar de um segundo SELECT a cada linha do histórico.
--
-- Escopo desta versão: só é possível citar mensagens do CLIENTE (não do
-- próprio bot/atendente) — ver comentário em message.controller.js
-- (_buscarContextoCitacao) para o motivo (message_id de uma linha de
-- histórico é ambíguo entre "id da mensagem do cliente" e "id da mensagem
-- que o atendente mandou", dependendo de qual fluxo criou a linha).
ALTER TABLE history ADD COLUMN IF NOT EXISTS quoted_message_id TEXT;
ALTER TABLE history ADD COLUMN IF NOT EXISTS quoted_text       TEXT;
