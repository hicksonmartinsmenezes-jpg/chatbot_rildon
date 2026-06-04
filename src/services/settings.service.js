const settingsRepository =
  require("../repositories/settings.repository");
const logger = require("../utils/logger");

const DEFAULT_SETTINGS = {
  empresa: {
    nome: "Rildon Eletropeças",
    telefone: "",
    horario: "Segunda a sexta, das 08h às 18h",
    logo: "android-chrome-512x512.png",
    mensagemBoasVindas:
      "Olá! Seja bem-vindo(a). Como podemos ajudar você hoje?"
  },
  bot: {
    ativo: true,
    foraHorario: true,
    timeoutAviso: 3,
    timeoutEncerramento: 5,
    menuPrincipal:
      "1 - Dúvidas frequentes\n2 - Nossos serviços\n3 - Horário de atendimento\n4 - Suporte técnico\n5 - Vendas / Orçamento\n6 - Financeiro\n7 - Falar com atendente"
  },
  atendimento: {
    setores:
      "Suporte Técnico, Vendas, Financeiro, Atendimento Humano",
    statusPadrao: "aberto",
    mensagemTransferencia:
      "Certo! Vou encaminhar você para um atendente humano. Aguarde um momento, por favor."
  },
  aparencia: {
    tema: "dark",
    corPrincipal: "#1d6cf5",
    corSucesso: "#2ecc71",
    nomePainel:
      "Rildon Painel de Atendimento"
  },
  notificacoes: {
    som: true,
    alertaVisual: true,
    mensagemToast:
      "Novo atendimento recebido!"
  },
  historico: {
    manterDias: 90,
    limiteConversas: 100,
    exportacao: "json"
  }
};

function mergeDeep(base, extra) {
  const output = Array.isArray(base)
    ? [...base]
    : { ...base };

  if (!extra || typeof extra !== "object") {
    return output;
  }

  for (const [key, value] of Object.entries(extra)) {

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      output[key] =
        mergeDeep(output[key] || {}, value);
    } else if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

// MELHORIA: cache em memória de 30s para evitar query ao banco em cada mensagem recebida.
// getBotConfig() era chamado 2x por mensagem (whatsapp.js + message.service.js).
// invalidateSettingsCache() deve ser chamado sempre que saveSettings() ou resetSettings() for usado.
let _settingsCache    = null;
let _settingsCacheAt  = 0;
const SETTINGS_CACHE_TTL = 30_000; // 30 segundos

function invalidateSettingsCache() {
  _settingsCache = null;
  _settingsCacheAt = 0;
}

async function getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < SETTINGS_CACHE_TTL) {
    return _settingsCache;
  }

  const saved = await settingsRepository.get("panel_settings");
  _settingsCache = mergeDeep(DEFAULT_SETTINGS, saved || {});
  _settingsCacheAt = Date.now();

  return _settingsCache;
}

async function saveSettings(settings) {
  const merged =
    mergeDeep(
      DEFAULT_SETTINGS,
      settings || {}
    );

  await settingsRepository.set(
    "panel_settings",
    merged
  );

  invalidateSettingsCache(); // MELHORIA: invalida cache após salvar
  return merged;
}

async function resetSettings() {
  await settingsRepository.set(
    "panel_settings",
    DEFAULT_SETTINGS
  );

  invalidateSettingsCache(); // MELHORIA: invalida cache após reset
  return DEFAULT_SETTINGS;
}

logger.info("⚙️ PostgreSQL: configurações carregadas");

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  resetSettings,
  invalidateSettingsCache
};