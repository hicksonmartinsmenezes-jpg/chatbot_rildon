const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const SETTINGS_PATH = path.join(__dirname, "../data/settings.json");

async function getBotConfig() {
  let settings = {};

  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
  } catch (error) {
    logger.error("Erro ao ler settings.json:", error.message);
  }

  const bot = settings.bot || {};

  return {
    ativo: bot.ativo ?? true,

    mensagemBoasVindas:
      bot.mensagemBoasVindas ||
      "Olá! Seja bem-vindo(a).\n\nComo podemos ajudar você hoje?",

    mensagemForaHorario:
      bot.mensagemForaHorario ||
      "No momento estamos fora do horário de atendimento.",

    timeoutAviso: bot.timeoutAviso || 3,
    timeoutEncerramento: bot.timeoutEncerramento || 5,

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