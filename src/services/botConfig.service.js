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
    opcoesMenu: bot.opcoesMenu || ""
  };
}

async function montarMenuPrincipal() {
  const bot = await getBotConfig();

  if (bot.menuPrincipal && bot.menuPrincipal.trim()) {
    return bot.menuPrincipal;
  }

  return bot.mensagemBoasVindas;
}

module.exports = {
  getBotConfig,
  montarMenuPrincipal
};