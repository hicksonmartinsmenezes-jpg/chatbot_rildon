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
    // Pedido do usuário: a loja só vende produtos, não presta serviços —
    // removida a opção "Nossos serviços" deste menu padrão (este campo é só
    // um valor default configurável no painel; o menu REAL mostrado ao
    // cliente é o hardcoded em src/flows/main.flow.js, que já nunca mencionou
    // "serviços" — mas esse default aparecia enganosamente na aba
    // Configurações do painel caso ninguém tivesse customizado ainda).
    menuPrincipal:
      "1 - Dúvidas frequentes\n2 - Horário de atendimento\n3 - Suporte técnico\n4 - Vendas / Orçamento\n5 - Financeiro\n6 - Falar com atendente"
  },
  atendimento: {
    setores:
      "Suporte Técnico, Vendas, Financeiro, Atendimento Humano",
    statusPadrao: "aberto",
    mensagemTransferencia:
      "Certo! Vou encaminhar você para um atendente humano. Aguarde um momento, por favor.",
    // Pedido do usuário: quando um atendente/supervisor aceita um
    // atendimento, o cliente recebe automaticamente essa mensagem se
    // apresentando (mesmo número do bot — sem trocar de canal). "{nome}" é
    // substituído pelo nome de quem assumiu. Deixe em branco pra desativar.
    mensagemSaudacaoAtendente:
      "Olá! 👋 Me chamo {nome} e vou continuar seu atendimento a partir de agora.",
    // Pedido do usuário: pesquisa de satisfação automática ao fechar um
    // atendimento (status → resolvido). Cliente responde só com um número
    // de 1 a 5 (ver parseSatisfactionRating em message.service.js). Deixe
    // em branco pra desativar.
    mensagemPesquisaSatisfacao:
      "De 1 a 5, o quanto você ficou satisfeito com nosso atendimento? Responda só com o número. 🙂",
    // Pedido do usuário: quando a nota da pesquisa acima vem baixa (1 ou 2 —
    // ver SATISFACTION_LOW_THRESHOLD em ticket.service.js), pergunta em
    // seguida o que pode melhorar, antes do agradecimento final. A resposta
    // fica salva em tickets.satisfaction_feedback (migration 018).
    mensagemPedirMelhoria:
      "Poxa, sentimos muito! 😕 O que podemos melhorar?",
    mensagemAgradecimentoPesquisa:
      "Muito obrigado pela sua avaliação! 🙏",
    // Pedido do usuário (2026-07-30): tempo (em minutos) que evita reenviar
    // a pesquisa de satisfação (e a saudação do atendente) quando um ticket
    // fechado é reaberto — automaticamente (cliente manda mensagem de novo)
    // ou manualmente (botão "Reabrir" em Fechados). Fora dessa janela, é
    // tratado como atendimento novo e a pesquisa dispara normalmente de
    // novo ao fechar. Antes só existia via variável de ambiente
    // TICKET_REOPEN_WINDOW_MINUTOS (sem UI); o default abaixo preserva o
    // valor já configurado no .env pra quem já tinha isso ajustado.
    tempoReaberturaSemPesquisa: Number(process.env.TICKET_REOPEN_WINDOW_MINUTOS) || 60
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