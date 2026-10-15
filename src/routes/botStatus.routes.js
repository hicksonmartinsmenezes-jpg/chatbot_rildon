const express      = require("express");
const asyncHandler = require("../utils/asyncHandler");
const { getSettings, saveSettings } = require("../services/settings.service");
const { addLog }    = require("../services/activityLog.service");
const { emitEvent } = require("../services/socket.service");

const router = express.Router();

// Rota enxuta, liberada para QUALQUER usuário autenticado (ver app.js — ao
// contrário de settings.routes.js, que continua admin-only e expõe TODA a
// Central de Configurações). Pedido do usuário (2026-07-24): todo atendente
// deve poder ligar/desligar o bot direto do painel, sem precisar de acesso
// admin. Só o campo bot.ativo passa por aqui — o resto das configurações do
// bot (mensagens, timeouts, respostas rápidas, editor de fluxos) continua
// restrito a admin.
router.get("/bot-status", asyncHandler(async (req, res) => {
  const settings = await getSettings();

  // PEDIDO DO USUÁRIO (2026-09-23, "analise se as condições de reabrir esta
  // batendo"): o painel de Conversas (07-conversations.js, estaPendente())
  // precisava saber a mesma janela de reabertura configurável usada pelo
  // backend (atendimento.tempoReaberturaSemPesquisa, padrão 240min — ver
  // _getReopenWindowMs em ticket.service.js) pra decidir por quanto tempo um
  // cliente reengajado sem ticket novo continua aparecendo em Pendentes —
  // antes usava "mesmo dia do calendário", que fazia esse cliente sumir da
  // lista sozinho na virada da meia-noite, mesmo sem ninguém ter atendido.
  // GET /api/settings (settings.routes.js) é admin-only (requireScreenAccess
  // "chatbot"/"settings" em app.js) — a maioria dos atendentes não tem
  // acesso, então não dava pra usar de lá. Esta rota já é liberada pra
  // qualquer atendente logado (mesmo motivo do campo "ativo" abaixo), então
  // reaproveitada em vez de criar um endpoint novo só pra 1 número.
  const tempoReaberturaMinutos = Number(settings.atendimento?.tempoReaberturaSemPesquisa) > 0
    ? Number(settings.atendimento.tempoReaberturaSemPesquisa)
    : 240;

  res.json({ ativo: settings.bot?.ativo !== false, tempoReaberturaMinutos });
}));

router.put("/bot-status", asyncHandler(async (req, res) => {
  const { ativo } = req.body || {};

  if (typeof ativo !== "boolean") {
    return res.status(400).json({ error: "Campo 'ativo' deve ser true ou false." });
  }

  const saved = await saveSettings({ bot: { ativo } });

  await addLog(
    req.user,
    ativo ? "BOT_LIGADO" : "BOT_DESLIGADO",
    `${req.user.nome} ${ativo ? "ativou" : "desativou"} o bot pelo painel`
  );

  // Broadcast pra todos os painéis conectados verem o novo estado na hora,
  // sem esperar o próximo refresh/poll (mesmo padrão de ticket_atualizado).
  emitEvent("bot_status_atualizado", { ativo, por: req.user.nome });

  res.json({ ativo: saved.bot?.ativo !== false });
}));

module.exports = router;
