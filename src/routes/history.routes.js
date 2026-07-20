const express = require("express");
const router = express.Router();
const {
  getHistoryHandler,
  getHistoryGroupedHandler,
  getConversationsHandler,
  serveMediaHandler,
} = require("../controllers/history.controller");

// Retorna a última mensagem por usuário distinto (para o painel de conversas)
router.get("/history/conversations", getConversationsHandler);
// Retorna uma linha por cliente (mensagem mais recente + total de
// interações) — usado pela lista principal da aba Histórico, evita que
// clientes com conversas mais antigas sumam da tela (ver history.controller.js).
router.get("/history/grouped", getHistoryGroupedHandler);
// Serve o arquivo de mídia recebida (foto/áudio/vídeo/sticker/documento)
// salvo em src/media-recebida/ — ver migration 017. Protegida por
// authSession (aplicado em app.js pra todo /api/history*), diferente do
// handler público /uploads/* (fotos de perfil/campanha).
router.get("/history/media/:id", serveMediaHandler);
router.get("/history", getHistoryHandler);

module.exports = router;
