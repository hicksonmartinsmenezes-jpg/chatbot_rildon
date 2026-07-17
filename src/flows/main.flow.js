const { getSession, clearSession, updateSession, finalizarComTicket } = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { buscarNomeContatoReal }                              = require("../whatsapp/contacts");
const { estaEmHorarioDeAtendimento, mensagemForaDeHorario } = require("../utils/horario");
const { notificarAtendente, notificarSeDisponivel }         = require("../services/notificacao.service");
const { validarNome, sanitizarTexto, normalizar, validarTamanho } = require("../utils/validators");
const { perguntarIA }                                       = require("../services/ai.service");
const { getBotConfig }                                      = require("../services/botConfig.service");
const logger                                                = require("../utils/logger");
const MSG                                                   = require("./messages");
const pool                                                  = require("../database/postgres");

const vendasFlow      = require("./vendas.flow");
const crediarioFlow   = require("./crediario.flow");

// ── Palavras-chave de navegação ────────────────────────────────────────────────
// PALAVRAS_MENU: usado dentro dos fluxos de sector (gestao/atendente) para sair do fluxo
const PALAVRAS_MENU = new Set([
  "0", "menu", "inicio", "voltar", "home", "cancelar",
  "oi", "ola", "opa", "bom dia", "boa tarde", "boa noite",
]);

// PALAVRAS_NAV: apenas navegação explícita — para o check de topo (não inclui saudações)
const PALAVRAS_NAV = new Set([
  "0", "menu", "inicio", "voltar", "home", "cancelar",
]);

// Complementos sociais que ainda contam como saudação pura ("bom dia tudo bem?")
const COMPLEMENTOS_SAUDACAO = new Set([
  "", "tudo bem", "td bem", "tudo bom", "blz", "beleza",
  "pessoal", "amigo", "amiga", "gente", "a todos", "pra voce", "pra vc",
]);

// Detecta saudação PURA — apenas cumprimento, sem pedido real embutido.
// "bom dia" → true | "bom dia, quero um alternador" → false (vai para a IA)
function ehSaudacaoPura(msgNorm, msgSemPontuacao) {
  if (["oi", "ola", "opa", "eai", "e ai"].includes(msgSemPontuacao)) return true;
  for (const s of ["bom dia", "boa tarde", "boa noite"]) {
    if (msgNorm === s || msgSemPontuacao === s) return true;
    if (msgSemPontuacao.startsWith(s)) {
      const resto = msgSemPontuacao.slice(s.length).trim();
      if (COMPLEMENTOS_SAUDACAO.has(resto)) return true;
    }
  }
  return false;
}

const PALAVRAS_ENCERRAR = new Set([
  "encerrar", "encerramento", "fechar", "finalizar", "sair", "tchau", "bye",
]);

// Sectors gerenciados — qualquer outro é inválido e deve ser resetado
const SECTORS_VALIDOS = new Set(["vendas", "crediario", "gestao", "atendente"]);

// ── Fallback determinístico de extração de veículo ─────────────────────────────
// BUG RECORRENTE (testes reais com "Audi A4 2025"): a IA às vezes NÃO preenche
// o campo estruturado "veiculo" mesmo com o cliente tendo dito marca/modelo/ano
// claramente — e o bot pergunta "qual o veículo?" de novo, irritando o cliente.
// Este fallback só roda quando a IA retorna veiculo=null: procura uma marca
// conhecida na mensagem e captura até 3 tokens seguintes como modelo/ano,
// parando em stopwords ("tem audi na loja?" → só "Audi", não "Audi Na Loja").
const MARCAS_VEICULO = [
  "volkswagen", "vw", "chevrolet", "fiat", "ford", "toyota", "honda", "hyundai",
  "renault", "nissan", "jeep", "peugeot", "citroen", "audi", "bmw", "mercedes",
  "kia", "mitsubishi", "suzuki", "land rover", "volvo", "scania", "iveco",
  "ram", "dodge", "chery", "jac", "byd", "gwm", "subaru", "troller", "agrale",
  "yamaha", "kawasaki", "shineray", "haojue", "dafra",
];
const MARCAS_VEICULO_RE = new RegExp(
  `\\b(${MARCAS_VEICULO.join("|")})\\b((?:\\s+[a-z0-9.-]{1,15}){0,3})`
);
const STOPWORDS_MODELO = new Set([
  "na", "no", "de", "da", "do", "dos", "das", "pra", "para", "pro", "meu",
  "minha", "um", "uma", "ai", "aqui", "la", "voces", "vcs", "tem", "loja",
  "disponivel", "estoque", "e", "ou", "com", "sem", "por", "favor",
]);

function extrairVeiculoFallback(message) {
  const msg = normalizar(sanitizarTexto(message)).replace(/[?!.,;:]/g, " ");
  const m = msg.match(MARCAS_VEICULO_RE);
  if (!m) return null;
  const partes = [m[1]];
  for (const token of (m[2] || "").trim().split(/\s+/).filter(Boolean)) {
    if (STOPWORDS_MODELO.has(token)) break;
    partes.push(token);
  }
  // Capitaliza cada token ("audi a4 2025" → "Audi A4 2025")
  return partes
    .map(t => t.charAt(0).toUpperCase() + t.slice(1))
    .join(" ");
}

// ── Steps válidos por sector ───────────────────────────────────────────────────
const STEPS_POR_SECTOR = {
  gestao:     ["aguardando_nome", "aguardando_motivo_gestao"],
  atendente:  ["aguardando_motivo_atendente"],
  crediario:  ["aguardando_nome_cred", "aguardando_cpf", "aguardando_motivo_cred", "aguardando_nome_consulta_cred", "aguardando_cpf_consulta"],
  vendas:     ["aguardando_nome", "aguardando_veiculo", "aguardando_orcamento"],
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
    "4 - Horário e Localização\n\n" +
    "_Digite o número da opção desejada._"
  );
}

// ── Menu compacto (após resposta da IA — sem saudação e sem "Como posso ajudar") ─
function menuCompacto() {
  const aberto = estaEmHorarioDeAtendimento();
  const status = aberto ? "🟢 Atendimento aberto" : "🔴 *Fora do horário de atendimento*";
  return (
    `${status}\n\n` +
    "1 - Orçamento / Falar com atendente\n" +
    "2 - Crediário\n" +
    "3 - Falar com a Equipe\n" +
    "4 - Horário e Localização\n\n" +
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

// ── Busca nome de cliente retornando (contato real, ticket ou histórico) ─────
// Pedido do usuário: a saudação estava usando o nome DIGITADO manualmente
// num orçamento antigo (tickets.customer_name) — que pode ficar "preso" a
// um atendimento anterior e não refletir quem está mandando mensagem
// agora. Prioridade: contacts.nome (nome real do contato — ver
// buscarNomeContatoReal em src/whatsapp/contacts.js, fonte única
// compartilhada também por ticket.controller.js e message.controller.js)
// > customer_name do ticket (digitado, fallback) > contact_name do
// histórico (mesmo pushName, cópia mais antiga, último fallback).
async function _buscarNomeCliente(userId) {
  try {
    const nomeContato = await buscarNomeContatoReal(userId);
    if (nomeContato) return nomeContato;

    // Fallback: nome digitado manualmente num ticket anterior
    const ticketRes = await pool.query(
      `SELECT customer_name FROM tickets WHERE user_id = $1 AND customer_name IS NOT NULL AND customer_name != 'Não informado' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (ticketRes.rows[0]?.customer_name) return ticketRes.rows[0].customer_name;

    // Último fallback: histórico de mensagens
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

  // ── Navegação explícita (0, menu, voltar...) → menu direto ──────────────────
  const eNavegacao =
    PALAVRAS_NAV.has(msgNorm) ||
    PALAVRAS_NAV.has(msgSemPontuacao);

  if (eNavegacao) {
    await clearSession(userId);
    return menuPrincipal(nomeSalvo);
  }

  // ── Saudações puras ("oi", "bom dia"...) ────────────────────────────────────
  // Saudação COM pedido embutido ("bom dia, quero alternador") NÃO entra aqui —
  // cai no default e a IA interpreta a intenção real.
  const eSaudacao = ehSaudacaoPura(msgNorm, msgSemPontuacao);

  if (eSaudacao) {
    if (session.sector && session.sector !== "main") {
      // Mid-flow → sai do fluxo e volta ao menu
      await clearSession(userId);
      return menuPrincipal(nomeSalvo);
    }
    // Sem fluxo ativo → greeting personalizado, sem chamar IA
    await clearSession(userId);
    if (nomeSalvo) {
      const primeiroNome = nomeSalvo.trim().split(" ")[0];
      return (
        `Olá, *${primeiroNome}*! Bem-vindo de volta à *Rildon Eletropeças*! ⚡\n\n` +
        "Como posso te ajudar hoje?\n\n" +
        menuCompacto()
      );
    }
    // Cliente novo — exibe menu direto (nome será capturado no fluxo escolhido)
    return (
      "Bem-vindo à *Rildon Eletropeças*! ⚡\n\n" +
      "Como posso te ajudar?\n\n" +
      menuCompacto()
    );
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
      await finalizarComTicket(userId, ticket);
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
      await finalizarComTicket(userId, ticket);
      return MSG.main.ATENDENTE_HUMANO(ticket);
    }

    await clearSession(userId);
    return menuPrincipal(nomeSalvo);
  }

  // ── Confirmação pendente de orçamento (CONFIRMAR_ORCAMENTO) ──────────────────
  // Pedido do usuário: aceitar tanto "sim" (resposta natural a uma pergunta
  // de sim/não) quanto "1" (mesmo número do menu principal, por quem
  // responde por hábito) como confirmação do orçamento sugerido. Sem este
  // intercept ANTES do switch abaixo, "1" cairia no "case 1" genérico e
  // reiniciaria o fluxo de vendas do zero (perguntando veículo de novo
  // mesmo já sabendo veiculoSugerido/pecaSugerido) — a mesma regressão que
  // estivemos corrigindo a conversa inteira. "0"/"menu"/saudação já limpam
  // a sessão (e portanto essa flag) mais acima, então não precisam de
  // tratamento especial aqui.
  if (session.aguardandoConfirmacaoOrcamento) {
    if (msgNorm === "sim" || msgNorm === "1") {
      const veiculoFinal = session.veiculoSugerido || null;
      const pecaFinal     = session.pecaSugerido    || null;

      if (veiculoFinal && nomeSalvo) {
        const confirmacao = await vendasFlow.finalizarOrcamento(
          userId,
          { customerName: nomeSalvo },
          veiculoFinal,
          pecaFinal || "Consulta de peça"
        );
        return confirmacao;
      }

      if (nomeSalvo) {
        const primeiroNome = nomeSalvo.trim().split(" ")[0];
        await updateSession(userId, {
          sector: "vendas",
          step: "aguardando_veiculo",
          customerName: nomeSalvo,
          pecaInicial: pecaFinal,
          aguardandoConfirmacaoOrcamento: undefined,
        });
        return `Certo, *${primeiroNome}*! ` + MSG.vendas.PEDIR_VEICULO + MSG.ESCAPE_DICA;
      }

      await updateSession(userId, {
        sector: "vendas",
        step: "aguardando_nome",
        veiculoInicial: veiculoFinal,
        pecaInicial: pecaFinal,
        aguardandoConfirmacaoOrcamento: undefined,
      });
      return MSG.vendas.PEDIR_NOME + MSG.ESCAPE_DICA;
    }

    // Mensagem diferente de "sim"/"1" — não confirma agora. Limpa a flag pra
    // não reaproveitar veiculoSugerido/pecaSugerido "velhos" numa consulta
    // futura sem relação com esta, e segue o processamento normal abaixo.
    await updateSession(userId, { aguardandoConfirmacaoOrcamento: undefined });
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

      // Vendas: vai direto para o formulário, sem submenu intermediário
      // BUG CORRIGIDO: o cliente já diz o que quer logo na 1ª mensagem
      // ("quero orçamento de uma palheta") e o fluxo, mais na frente,
      // perguntava de novo "qual peça ou serviço você precisa?" — o
      // cliente responde "já falei" (frustrado) e isso vira literalmente
      // a descrição do orçamento. Guardamos a mensagem original em
      // "produtoInicial"; vendas.flow.js usa ela pra pular essa pergunta
      // redundante quando já é descritiva o suficiente.
      if (intencao === "vendas") {
        // Pedido do usuário: quando o cliente já menciona peça + veículo na
        // 1ª mensagem (ex: "motor de partida fiat palio 2025"), a IA tenta
        // extrair o veículo (campo "veiculo" — ver ai.service.js). Se
        // conseguir E a mensagem for descritiva o bastante como peça (mesmo
        // limiar já usado em vendas.flow.js pra pular a pergunta de peça),
        // pulamos também a pergunta "qual o veículo?".
        const produtoDescritivo = validarTamanho(normalizar(sanitizarTexto(message)), 5).ok;
        // Preferência: campo estruturado da IA; fallback: regex de marcas
        // conhecidas (ver extrairVeiculoFallback acima) — cobre os casos em
        // que a IA falha em extrair modelos raros/importados ("Audi A4 2025").
        const veiculoFallback   = produtoDescritivo && !resultado.veiculo
          ? extrairVeiculoFallback(message)
          : null;
        if (veiculoFallback) {
          // Sinal de qualidade: a IA deveria ter preenchido "veiculo" e não
          // preencheu — o fallback está compensando uma falha de extração.
          logger.warn(`[mainFlow] fallback de veiculo recuperou "${veiculoFallback}" que a IA não extraiu — userId=${userId} msg="${message}"`);
        }
        const veiculoExtraido   = produtoDescritivo
          ? (resultado.veiculo || veiculoFallback)
          : null;
        // Pedido do usuário (relatado após o primeiro ajuste): a descrição
        // do ticket ficava com a frase inteira do cliente, saudação
        // incluída (ex: "Produto: Bom dia, motor de partida fiat 2025").
        // Quando a IA consegue isolar só o nome da peça, preferimos esse
        // texto limpo — cai pra mensagem original só se a IA não
        // identificar a peça com clareza (ver ai.service.js).
        const pecaExtraida     = resultado.peca || null;

        // BUG REAL (ticket #2026-0056): cliente só perguntou "tem motor de
        // partida fiat palio?" — uma pergunta de disponibilidade, não um
        // pedido — e o sistema criou o orçamento sozinho, sem confirmação.
        // "vendas" cobre tanto pedidos quanto perguntas (ver definição em
        // ai.service.js), então só auto-avançamos (pular perguntas/criar
        // ticket direto) quando a IA sinaliza "pedidoExplicito" — o cliente
        // realmente pediu o orçamento/compra, não só consultou.
        //
        // BUG REAL (ticket #2026-0068, mesmo tipo do #2026-0056 voltando):
        // mesmo com essa regra, a IA às vezes classifica pedidoExplicito
        // como true numa pergunta CLARAMENTE de disponibilidade (ex: "tem
        // motor de partida pra audi a4 2025?") — limitação de
        // confiabilidade do modelo grátis (ver conversa com o usuário).
        // Rede de segurança determinística: se a mensagem do cliente bate
        // com o padrão clássico de pergunta de disponibilidade (os MESMOS
        // exemplos de "false" já documentados no prompt de ai.service.js —
        // "tem X?", "vocês trabalham com X?", "existe X aí?") E termina em
        // "?", tratamos pedidoExplicito como false independente do que a
        // IA respondeu — só pode DOWNGRADE (nunca cria ticket sem
        // confirmação a mais), nunca upgrade, então o pior caso é pedir
        // "digite sim" uma vez a mais, nunca criar ticket sem consentimento.
        const PERGUNTA_DISPONIBILIDADE_RE = /\b(tem|te m|voce tem|voces tem|vc tem|vcs tem|trabalham com|existe|ha|vende|vendem|possui|possuem|encontro)\b.*\?\s*$/;
        const pareceApenasPerguntaDisponibilidade = PERGUNTA_DISPONIBILIDADE_RE.test(normalizar(message));
        const pedidoExplicitoConfirmado = resultado.pedidoExplicito && !pareceApenasPerguntaDisponibilidade;

        // Sinal de qualidade: toda vez que a rede de segurança precisa agir
        // é porque a IA classificou errado — logar dá visibilidade de quão
        // frequente é essa falha de classificação sem precisar reproduzir
        // via print de WhatsApp toda vez.
        if (resultado.pedidoExplicito && pareceApenasPerguntaDisponibilidade) {
          logger.warn(`[mainFlow] pedidoExplicito rebaixado (parece pergunta de disponibilidade) — userId=${userId} msg="${message}"`);
        }

        if (!pedidoExplicitoConfirmado) {
          // Guarda o que já foi identificado nesta consulta (pode ser null)
          // pra reaproveitar se o cliente confirmar ("sim", "quero") na
          // próxima mensagem — evita perguntar tudo de novo depois.
          const veiculoConhecido = veiculoExtraido || session.veiculoSugerido || null;
          const pecaConhecida    = pecaExtraida    || session.pecaSugerido    || null;

          // BUG CORRIGIDO (relatado pelo usuário, 2 cenários diferentes):
          // 1) Empilhar "quer que eu registre o orçamento?" em cima de uma
          //    pergunta que a própria IA já fez (ex: "qual o ano do
          //    veículo?") confundia sobre o que responder — só um dos dois
          //    devia aparecer.
          // 2) O gate anterior (só oferecer confirmação quando veículo E
          //    peça já eram conhecidos) deixava o cliente sem NENHUM
          //    caminho quando a IA dava uma resposta completa mas não
          //    conseguia extrair os campos estruturados (ex: "tem motor de
          //    partida pra audi a4 2025?" → IA responde de forma
          //    informativa e confiante, mas sem preencher veiculo/peca —
          //    cliente ficava sem saber que podia simplesmente responder
          //    "sim" pra registrar o orçamento).
          // O que realmente importa não é se veículo/peça foram extraídos,
          // e sim se a IA JÁ está perguntando algo agora — nesse caso
          // (resposta termina em "?"), deixa só a pergunta dela em pé.
          // Caso contrário (resposta "fechada"/informativa), sempre oferece
          // a confirmação determinística — é o único jeito do cliente
          // saber que pode só responder "sim".
          const iaJaPerguntouAlgo = /\?\s*$/.test(resposta);

          // aguardandoConfirmacaoOrcamento: true só quando de fato mostramos
          // o CONFIRMAR_ORCAMENTO agora — usado pelo intercept de "sim"/"1"
          // logo antes do switch de menu (ver comentário lá).
          await updateSession(userId, {
            aiHistorico: novoHistorico,
            _iaFalhas: 0,
            veiculoSugerido: veiculoConhecido,
            pecaSugerido:    pecaConhecida,
            aguardandoConfirmacaoOrcamento: !iaJaPerguntouAlgo,
          });

          if (!iaJaPerguntouAlgo) {
            return resposta + "\n\n" + MSG.vendas.CONFIRMAR_ORCAMENTO;
          }
          return resposta;
        }

        // pedidoExplicito confirmado — usa o que a IA extraiu agora, ou o
        // que já tinha sido sugerido numa consulta anterior (ex: cliente só
        // respondeu "sim" pra pergunta anterior, sem repetir veículo/peça).
        const veiculoFinal = veiculoExtraido || session.veiculoSugerido || null;
        const pecaFinal     = pecaExtraida    || session.pecaSugerido    || null;
        const produtoTexto  = pecaFinal || message;

        if (veiculoFinal && nomeSalvo) {
          // Nome + veículo + peça já conhecidos — finaliza o orçamento
          // direto, sem nenhuma pergunta extra. Persiste o histórico ANTES
          // de finalizar, pra finalizarComTicket (chamado dentro de
          // finalizarOrcamento) já ver esta troca ao anexar a confirmação.
          await updateSession(userId, { aiHistorico: novoHistorico, _iaFalhas: 0, customerName: nomeSalvo });
          const confirmacao = await vendasFlow.finalizarOrcamento(
            userId,
            { customerName: nomeSalvo },
            veiculoFinal,
            produtoTexto
          );
          return resposta + "\n\n" + confirmacao;
        }

        if (nomeSalvo) {
          const primeiroNome = nomeSalvo.trim().split(" ")[0];
          await updateSession(userId, { sector: "vendas", step: "aguardando_veiculo", customerName: nomeSalvo, produtoInicial: message, pecaInicial: pecaFinal, aiHistorico: novoHistorico, _iaFalhas: 0 });
          return resposta + "\n\n" + `Certo, *${primeiroNome}*! ` + MSG.vendas.PEDIR_VEICULO + MSG.ESCAPE_DICA;
        }

        // Sem nome ainda — guarda o veículo/peça já extraídos (podem ser
        // null) pra vendas.flow.js pular as perguntas assim que o nome for
        // informado (ver step "aguardando_nome" em vendas.flow.js).
        await updateSession(userId, {
          sector: "vendas",
          step: "aguardando_nome",
          produtoInicial: message,
          veiculoInicial: veiculoFinal,
          pecaInicial: pecaFinal,
          aiHistorico: novoHistorico,
          _iaFalhas: 0
        });
        return resposta + "\n\n" + MSG.vendas.PEDIR_NOME + MSG.ESCAPE_DICA;
      }

      // Crediário: mostra o submenu (tem 2 opções: solicitar ou consultar)
      if (intencao === "crediario") {
        await updateSession(userId, { sector: "crediario", aiHistorico: novoHistorico, _iaFalhas: 0 });
        return resposta + "\n\n" + MSG.crediario.MENU();
      }

      if (intencao === "atendente") {
        await updateSession(userId, { sector: "atendente", step: "aguardando_motivo_atendente", aiHistorico: novoHistorico, _iaFalhas: 0 });
        return resposta + "\n\n" + MSG.main.PEDIR_MOTIVO_ATENDENTE;
      }

      if (intencao === "gestao" || intencao === "suporte") {
        await updateSession(userId, { sector: "gestao", step: "aguardando_nome", aiHistorico: novoHistorico, _iaFalhas: 0 });
        return resposta + "\n\n" + MSG.gestao.PEDIR_NOME + MSG.ESCAPE_DICA;
      }

      // Intenção "chat" — saudações ou mensagem não reconhecida: resposta + menu compacto
      await updateSession(userId, { aiHistorico: novoHistorico, _iaFalhas: 0 });
      return resposta + "\n\n" + menuCompacto();
    }
  }
}

module.exports = mainFlow;
