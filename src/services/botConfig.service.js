const { getSettings } = require("./settings.service");

async function getBotConfig() {
  const settings = await getSettings();
  const bot = settings.bot || {};

  return {
    ativo:
      bot.ativo === false || bot.ativo === "false"
        ? false
        : true,

    mensagemBoasVindas:
      bot.mensagemBoasVindas ||
      "Olá! Seja bem-vindo(a).\n\nComo podemos ajudar você hoje?",

    mensagemForaHorario:
      bot.mensagemForaHorario ||
      "No momento estamos fora do horário de atendimento.",

    timeoutAviso: Number(bot.timeoutAviso || 3),
    timeoutEncerramento: Number(bot.timeoutEncerramento || 5),

    mensagemEncerramento:
      bot.mensagemEncerramento ||
      "Atendimento encerrado por inatividade.",

    menuPrincipal: bot.menuPrincipal || "",
    opcoesMenu: bot.opcoesMenu || "",

    // IA ativa por padrão — pode ser desligada pelo painel (bot.iaAtiva = false)
    iaAtiva: bot.iaAtiva !== false,
  };
}

async function montarMenuPrincipal() {
  const bot = await getBotConfig();

  if (bot.menuPrincipal && bot.menuPrincipal.trim()) {
    return bot.menuPrincipal;
  }

  return bot.mensagemBoasVindas;
}

// Fonte ÚNICA da regra de prioridade entre as duas exceções pedidas pelo
// usuário (2026-07-24) — usada tanto em config/whatsapp.js (auto-respostas
// locais: aviso de mídia não suportada, "digitando...") quanto em
// message.service.js (processMessage, que decide se roda mainFlow/IA/ERP).
// Mantida num só lugar para as duas cópias nunca divergirem.
//
// Prioridade: tag "Funcionário" > número de teste (TEST_NUMBERS) > ativo
// normal do painel.
//   - isFuncionario=true  → SEMPRE "desligado" (nunca responde
//     automaticamente), mesmo com o bot ativo=true no painel ou o número
//     estando na lista de teste.
//   - ativo=false + isNumeroTeste=true + isFuncionario=false → bot segue
//     LIGADO pra esse número, ignorando o ativo=false.
//   - qualquer outro caso → segue o ativo=false do painel normalmente.
function resolverBotOffEfetivo({ ativoFalse, isNumeroTeste = false, isFuncionario = false }) {
  if (isFuncionario) return true;
  if (ativoFalse && isNumeroTeste) return false;
  return ativoFalse;
}

module.exports = {
  getBotConfig,
  montarMenuPrincipal,
  resolverBotOffEfetivo
};