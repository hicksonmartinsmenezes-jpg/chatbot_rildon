const { getSession, clearSession, updateSession }           = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente, notificarSeDisponivel }         = require("../services/notificacao.service");
const { validarNome, sanitizarTexto, normalizar }           = require("../utils/validators");
const { perguntarIA }                                       = require("../services/ai.service");
const { getBotConfig }                                      = require("../services/botConfig.service");
const logger                                                = require("../utils/logger");
const MSG                                                   = require("./messages");
const pool                                                  = require("../database/postgres");

const vendasFlow      = require("./vendas.flow");
const crediarioFlow   = require("./crediario.flow");
const suporteFlow     = require("./suporte.flow");

// ── Palavras-chave de navegação ────────────────────────────────────────────────
const PALAVRAS_MENU = new Set([
  "0", "menu", "inicio", "voltar", "home", "cancelar",
  "oi", "ola", "opa", "bom dia", "boa tarde", "boa noite",
]);

const PALAVRAS_ENCERRAR = new Set([
  "encerrar", "encerramento", "fechar", "finalizar", "sair", "tchau", "bye",
]);

// Sectors gerenciados — qualquer outro é inválido e deve ser resetado
const SECTORS_VALIDOS = new Set(["vendas", "crediario", "gestao", "atendente", "suporte"]);

// ── Steps válidos por sector ───────────────────────────────────────────────────
const STEPS_POR_SECTOR = {
  gestao:     ["aguardando_nome", "aguardando_motivo_gestao"],
  atendente:  ["aguardando_motivo_atendente"],
  crediario:  ["aguardando_nome_cred", "aguardando_cpf", "aguardando_motivo_cred", "aguardando_nome_consulta_cred", "aguardando_cpf_consulta"],
  vendas:     ["aguardando_nome", "aguardando_veiculo", "aguardando_orcamento"],
  suporte:    ["aguardando_problema", "aguardando_nome", "aguardando_cpf", "aguardando_cpf_consulta"],
};

// ── Menu principal ─────────────────────────────────────────────────────────────
function menuPrincipal(nome) {
  const aberto       = estaEmHorarioDeAtendimento();
  const status       = aberto ? "🟢 Atendimento aberto" : "🔴 *Fora do horário de atendimento*";
  const primeiroNome = nome ? nome.trim().split(" ")[0] : null;
  const saudacao     = primeiroNome
    ? `Olá, *${primeiroNome}*! Seja bem-vindo de volta à *Rildon Eletropeças*. ⚡`
    : "Olá! Seja bem-vindo à *Rildon Eletropeças*. ⚡";

  return (
    `${status}\n\n${saudacao}\n\n` +
    "Como posso ajudar você hoje?\n\n" +
    "1 - Orçamento / Falar com atendente\n" +
    "2 - Crediário\n" +
    "3 - Falar com a Equipe\n" +
    "4 - Horário e Localização\n" +
    "5 - Suporte Técnico\n\n" +
    "_Digite o número da opção desejada._"
  );
}

// ── Mensagem de fallback global (nunca expõe erro técnico ao cliente) ──────────
function _msgFallback(nomeSalvo) {
  return (
    "😅 Desculpe, tive um pequeno problema aqui. Por favor, tente novamente.\n\n" +
    "_Se o problema persistir, ligue: *(79) 99135-3569*_\n\n" +
    menuPrincipal(nomeSalvo)
  );
}

// ── Cria ticket com log de falha ───────────────────────────────────────────────
async function _criarTicket(dados) {
  try {
    const ticket = await createTicket(dados);
    if (!ticket) throw new Error("createTicket retornou nulo");
    return ticket;
  } catch (err) {
    logger.error(`[_criarTicket] Falha ao criar ticket para ${dados.userId}: ${err.message}`);
    return null;
  }
}

// ── Busca nome de cliente retornando (ticket ou histórico anterior) ──────────
async function _buscarNomeCliente(userId) {
  try {
    // Verifica primeiro em tickets (nome mais confiável — informado pelo próprio cliente)
    const ticketRes = await pool.query(
      `SELECT customer_name FROM tickets WHERE user_id = $1 AND customer_name IS NOT NULL AND customer_name != 'Não informado' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (ticketRes.rows[0]?.customer_name) return ticketRes.rows[0].customer_name;

    // Fallback: histórico de mensagens
    const histRes = await pool.query(
      `SELECT contact_name FROM history WHERE user_id = $1 AND contact_name IS NOT NULL AND contact_name != '' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    return histRes.rows[0]?.contact_name || null;
  } catch (err) {
    logger.warn(`[_buscarNomeCliente] ${err.message}`);
    return null;
  }
}

// ── Consulta de ticket por protocolo ────────────────────────────────────────
async function _consultarProtocolo(userId, message) {
  const match = message.trim().match(/^(?:protocolo\s*#?|#)(\d{4}-\d{3,4}|\d{1,4})$/i);
  if (!match) return null;

  const num = match[1];

  try {
    const res = await pool.query(
      `SELECT protocolo, customer_name, status, type, description, created_at, updated_at
       FROM tickets
       WHERE user_id = $1
         AND protocolo ILIKE $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, `%${num}%`]
    );

    const t = res.rows[0];
    if (!t) {
      return `🔍 Nenhum ticket encontrado com esse protocolo.\n\nVerifique o número e tente novamente.\n_Ex: Digite *#2024-0001*_\n\n${MSG.VOLTAR_MENU}`;
    }

    const statusLabel = {
      aberto:       "🟡 Aguardando atendimento",
      em_andamento: "🔵 Em andamento",
      resolvido:    "✅ Resolvido",
      cancelado:    "❌ Cancelado",
    }[t.status] || t.status;

    const criado     = new Date(t.created_at).toLocaleString("pt-BR", { timeZone: process.env.TZ_NEGOCIO || "America/Maceio" });
    const atualizado = new Date(t.updated_at).toLocaleString("pt-BR", { timeZone: process.env.TZ_NEGOCIO || "America/Maceio" });

    return (
      `🎫 *Consulta de Protocolo*\n\n` +
      `📋 Protocolo: *#${t.protocolo}*\n` +
      `👤 Cliente: ${t.customer_name || "Não informado"}\n` +
      `📊 Status: ${statusLabel}\n` +
      `🕐 Aberto em: ${criado}\n` +
      `🔄 Atualizado: ${atualizado}\n\n` +
      (t.status === "aberto" || t.status === "em_andamento"
        ? "_Nosso time está trabalhando na sua solicitação._"
        : "_Seu atendimento foi concluído. Precisando de mais alguma coisa, é só chamar!_") +
      MSG.VOLTAR_MENU
    );
  } catch (err) {
    logger.error(`[consultarProtocolo] Erro para ${userId}: ${err.message}`);
    return null;
  }
}

// ── Função principal (com proteção global contra exceções) ────────────────────
async function mainFlow({ userId, message }) {
  try {
    return await _mainFlowInterno({ userId, message });
  } catch (err) {
    logger.error(`[mainFlow] Erro inesperado para ${userId}: ${err.message}\n${err.stack}`);
    try { await clearSession(userId); } catch (err) { logger.warn(`[mainFlow] Erro ao limpar sessão: ${err.message}`); }
    return _msgFallback(null);
  }
}

async function _mainFlowInterno({ userId, message }) {
  const session   = getSession(userId);
  const msgNorm   = normalizar(message);
  // Versão sem pontuação — permite que "Bom dia!", "oi!", "menu." batam no Set
  const msgSemPontuacao = msgNorm.replace(/[^\p{L}\p{N}\s]/gu, "").trim();

  // Reconhecimento de cliente retornando — busca nome no histórico quando sessão está vazia
  let nomeSalvo = session.nome || session.customerName || null;
  // getSession() retorna { sector: "main" } como padrão — "main" não é um sector real,
  // então o lookup de nome deve rodar quando o sector é "main" (sessão inicial) ou nulo.
  if (!nomeSalvo && (!session.sector || session.sector === "main")) {
    const nomeHistorico = await _buscarNomeCliente(userId);
    if (nomeHistorico) {
      nomeSalvo = nomeHistorico;
      // Persiste para não buscar de novo nesta sessão
      await updateSession(userId, { customerName: nomeHistorico });
    }
  }

  // ── Consulta de protocolo (ex: "#2024-0001" ou "protocolo 2024-0001") ────────
  if (/^(?:protocolo\s*#?|#)\d/i.test(message.trim())) {
    const respProtocolo = await _consultarProtocolo(userId, message);
    if (respProtocolo) return respProtocolo;
  }

  // ── Encerrar atendimento ─────────────────────────────────────────────────────
  if (PALAVRAS_ENCERRAR.has(msgNorm) || PALAVRAS_ENCERRAR.has(msgSemPontuacao)) {
    await clearSession(userId);
    return (
      "👋 *Atendimento encerrado!*\n\n" +
      "Obrigado por entrar em contato com a *Rildon Eletropeças*! 😊\n\n" +
      "Quando precisar é só chamar — estamos sempre aqui.\n" +
      "_Digite *0* para abrir o menu novamente._"
    );
  }

  // ── Voltar ao menu principal ─────────────────────────────────────────────────
  // Também detecta saudações com texto extra: "bom dia amigo", "boa tarde!" etc.
  const eSaudacaoOuMenu =
    PALAVRAS_MENU.has(msgNorm) ||
    PALAVRAS_MENU.has(msgSemPontuacao) ||
    ["bom dia", "boa tarde", "boa noite"].some(s => msgNorm.startsWith(s));

  if (eSaudacaoOuMenu) {
    await clearSession(userId);
    return menuPrincipal(nomeSalvo);
  }

  // ── Sanitização de sector inválido / step corrompido ─────────────────────────
  // "main" é o valor padrão do session.service — não é um sector real, ignora
  if (session.sector && session.sector !== "main") {
    const stepsValidos = STEPS_POR_SECTOR[session.sector];
    const stepInvalido = stepsValidos && session.step && !stepsValidos.includes(session.step);
    const sectorInvalido = !SECTORS_VALIDOS.has(session.sector);

    if (sectorInvalido || stepInvalido) {
      logger.warn(`[mainFlow] Sector/step inválido para ${userId}: sector=${session.sector} step=${session.step} — resetando`);
      await clearSession(userId);
      return menuPrincipal(nomeSalvo);
    }
  }

  // ── Fluxos de sub-menus ──────────────────────────────────────────────────────
  if (session.sector === "vendas") {
    if (session.step || /^\d$/.test(msgNorm)) {
      const resp = await vendasFlow(message, userId, session);
      return resp ?? menuPrincipal(nomeSalvo);
    }
    // Free-form sem step → cai no switch abaixo (default → IA)
  }

  if (session.sector === "crediario") {
    const resp = await crediarioFlow(message, userId, session);
    return resp ?? menuPrincipal(nomeSalvo);
  }

  if (session.sector === "suporte") {
    const resp = await suporteFlow(message, userId, session);
    return resp ?? menuPrincipal(nomeSalvo);
  }

  // ── Fluxo de gestão ──────────────────────────────────────────────────────────
  if (session.sector === "gestao") {
    if (PALAVRAS_MENU.has(msgNorm)) {
      await clearSession(userId);
      return menuPrincipal(nomeSalvo);
    }

    if (session.step === "aguardando_nome") {
      if (!validarNome(sanitizarTexto(message))) return MSG.NOME_INVALIDO + MSG.ESCAPE_DICA;
      await updateSession(userId, { customerName: sanitizarTexto(message), step: "aguardando_motivo_gestao" });
      return MSG.gestao.PEDIR_MOTIVO + MSG.ESCAPE_DICA;
    }

    if (session.step === "aguardando_motivo_gestao") {
      if (msgNorm.length < 5) return "⚠️ Por favor, descreva melhor o motivo." + MSG.ESCAPE_DICA;
      const ticket = await _criarTicket({
        userId,
        type:         "atendimento_gestao",
        sector:       "geral",
        customerName: session.customerName || MSG.NAO_INFORMADO,
        description:  sanitizarTexto(message),
      });
      if (!ticket) {
        await clearSession(userId);
        return "⚠️ Não consegui registrar sua solicitação agora.\n\nPor favor, ligue diretamente: *(79) 99135-3569*\n\n_Digite *0* para voltar ao menu._";
      }
      notificarAtendente(ticket);
      await clearSession(userId);
      return MSG.gestao.REGISTRADO(ticket);
    }

    await clearSession(userId);
    return menuPrincipal(nomeSalvo);
  }

  // ── Coleta de motivo para atendente humano ───────────────────────────────────
  if (session.sector === "atendente") {
    if (PALAVRAS_MENU.has(msgNorm)) {
      await clearSession(userId);
      return menuPrincipal(nomeSalvo);
    }

    if (session.step === "aguardando_motivo_atendente") {
      if (msgNorm.length < 3) {
        return "⚠️ Por favor, descreva brevemente o que precisa." + MSG.ESCAPE_DICA;
      }

      const ticket = await _criarTicket({
        userId,
        type:         "atendente_humano",
        sector:       "atendimento",
        customerName: nomeSalvo || MSG.NAO_INFORMADO,
        description:  sanitizarTexto(message),
      });

      if (!ticket) {
        await clearSession(userId);
        return "⚠️ Não consegui registrar seu atendimento agora.\n\nPor favor, ligue diretamente: *(79) 99135-3569*\n\n_Digite *0* para voltar ao menu._";
      }

      estaEmHorarioDeAtendimento() ? notificarAtendente(ticket) : notificarSeDisponivel(ticket);
      await clearSession(userId);
      return MSG.main.ATENDENTE_HUMANO(ticket);
    }

    await clearSession(userId);
    return menuPrincipal(nomeSalvo);
  }

  // ── Switch de opções do menu principal ───────────────────────────────────────
  switch (msgNorm) {

    case "1": {
      // Entra direto no formulário de orçamento — sem submenu intermediário
      const nomeExistente = nomeSalvo;
      if (nomeExistente) {
        const primeiroNome = nomeExistente.trim().split(" ")[0];
        await updateSession(userId, { sector: "vendas", step: "aguardando_veiculo", customerName: nomeExistente });
        return `Certo, *${primeiroNome}*! ` + MSG.vendas.PEDIR_VEICULO + MSG.ESCAPE_DICA;
      }
      await updateSession(userId, { sector: "vendas", step: "aguardando_nome" });
      return MSG.vendas.PEDIR_NOME + MSG.ESCAPE_DICA;
    }

    case "2": {
      const r2 = await crediarioFlow(message, userId, session);
      return r2 ?? menuPrincipal(nomeSalvo);
    }

    case "3": {
      await updateSession(userId, { sector: "gestao", step: "aguardando_nome" });
      return MSG.gestao.PEDIR_NOME + MSG.ESCAPE_DICA;
    }

    case "4":
      return (
        "🕐 *Horário de Atendimento*\n\n" +
        "🗓️ Segunda a sexta: *07:50h* às *17:50h*\n" +
        "🗓️ Sábado: *08:00h* às *12:00h*\n" +
        "🚫 Domingo: Fechado\n\n" +
        "📍 Av. Chanceler Osvaldo Aranha, 151 — Novo Paraíso, Aracaju/SE\n\n" +
        `${estaEmHorarioDeAtendimento() ? "✅ Estamos *abertos* agora!" : "⏰ No momento estamos *fechados*."}\n\n` +
        MSG.VOLTAR_MENU
      );

    case "5": {
      const r5 = await suporteFlow(message, userId, session);
      return r5 ?? menuPrincipal(nomeSalvo);
    }

    // ── Default: IA responde ─────────────────────────────────────────────────
    default: {
      const botConfig = await getBotConfig();

      // IA desativada → exibe o menu diretamente
      if (!botConfig.iaAtiva) {
        return menuPrincipal(nomeSalvo);
      }

      const historico = session.aiHistorico || [];
      let resultado = null;

      try {
        resultado = await perguntarIA(message, {
          nomeCliente: nomeSalvo,
          historico,
          contexto: { atendimentoAberto: estaEmHorarioDeAtendimento() },
        });
      } catch (err) {
        logger.error(`[mainFlow] Erro ao chamar IA para ${userId}: ${err.message}`);
      }

      // ── Fallback quando IA falha ─────────────────────────────────────────────
      if (!resultado) {
        const falhasIA = (session._iaFalhas || 0) + 1;
        await updateSession(userId, { _iaFalhas: falhasIA });

        if (falhasIA >= 2) {
          await clearSession(userId);
          return (
            "Estou com dificuldades técnicas no momento. 🙏\n\n" +
            "Para garantir seu atendimento, escolha uma opção:\n\n" +
            "1 - Orçamento / Falar com atendente\n" +
            "2 - Crediário\n\n" +
            "_Ou ligue: *(79) 99135-3569*_"
          );
        }

        return (
          "Não consegui processar sua mensagem agora. 😅\n\n" +
          "Tente novamente ou use o menu:\n\n" +
          menuPrincipal(nomeSalvo)
        );
      }

      // IA respondeu com sucesso — zera contador de falhas
      const { resposta, intencao } = resultado;
      const novoHistorico = [
        ...historico,
        { role: "user",  parts: [{ text: message }] },
        { role: "model", parts: [{ text: resposta }] },
      ].slice(-20);

      // ── Roteamento por intenção ────────────────────────────────────────────
      if (intencao === "vendas") {
        await updateSession(userId, { sector: "vendas", aiHistorico: novoHistorico, _iaFalhas: 0 });
        if (session.sector === "vendas") {
          return resposta + "\n\n_Para solicitar orçamento, escolha a opção *1*. Digite *0* para o menu._";
        }
        return resposta + "\n\n" + MSG.vendas.MENU();
      }

      if (intencao === "crediario") {
        await updateSession(userId, { sector: "crediario", aiHistorico: novoHistorico, _iaFalhas: 0 });
        if (session.sector === "crediario") {
          return resposta + "\n\n_Use as opções do menu acima ou *0* para voltar._";
        }
        return resposta + "\n\n" + MSG.crediario.MENU();
      }

      if (intencao === "atendente") {
        await updateSession(userId, { sector: "atendente", step: "aguardando_motivo_atendente", aiHistorico: novoHistorico, _iaFalhas: 0 });
        return resposta + "\n\n" + MSG.main.PEDIR_MOTIVO_ATENDENTE;
      }

      if (intencao === "gestao") {
        await updateSession(userId, { sector: "gestao", step: "aguardando_nome", aiHistorico: novoHistorico, _iaFalhas: 0 });
        return resposta + "\n\n" + MSG.gestao.PEDIR_NOME + MSG.ESCAPE_DICA;
      }

      if (intencao === "suporte") {
        await updateSession(userId, { sector: "suporte", aiHistorico: novoHistorico, _iaFalhas: 0 });
        return resposta + "\n\n" + MSG.suporte.MENU();
      }

      // Intenção "chat" — resposta livre da IA, sem menu forçado
      await updateSession(userId, { aiHistorico: novoHistorico, _iaFalhas: 0 });
      return resposta;
    }
  }
}

module.exports = mainFlow;
