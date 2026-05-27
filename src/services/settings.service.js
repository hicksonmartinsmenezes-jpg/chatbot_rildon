const settingsRepository =
  require("../repositories/settings.repository");

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

async function getSettings() {
  const saved =
    await settingsRepository.get(
      "panel_settings"
    );

  return mergeDeep(
    DEFAULT_SETTINGS,
    saved || {}
  );
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

  return merged;
}

async function resetSettings() {
  await settingsRepository.set(
    "panel_settings",
    DEFAULT_SETTINGS
  );

  return DEFAULT_SETTINGS;
}

console.log(
  "⚙️ PostgreSQL: configurações carregadas"
);

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  resetSettings
};