/**
 * test-flow.js — Simulador de conversa completo para o bot Rildon
 *
 * Roda sem WhatsApp, sem DB real e sem IA real.
 * Mocks: PostgreSQL (memória), IA (respostas pré-definidas), botConfig, notificações.
 *
 * Uso:  node test-flow.js
 *       node test-flow.js --suite vendas
 *       node test-flow.js --suite ia
 *       node test-flow.js --suite edge
 */

"use strict";

// ─── Argumento de suite ─────────────────────────────────────────────────────
const SUITE_ARG = process.argv.find(a => a.startsWith("--suite=") || a === "--suite")
  ? (process.argv.find(a => a.startsWith("--suite="))?.split("=")[1]
      || process.argv[process.argv.indexOf("--suite") + 1])
  : "all";

// Os roteiros abaixo validam diálogos completos (inclusive formulários com
// várias respostas). A transferência global após 3 mensagens tem testes
// próprios; deixamos o limite alto aqui para ela não interromper esses
// cenários antes de testar o comportamento que cada roteiro cobre.
process.env.LIMITE_MENSAGENS_BOT = "100";

// ─── Mock: PostgreSQL pool ──────────────────────────────────────────────────
const _dbSessions = {};
let _ticketCounter = 0;

const poolMock = {
  query: async (sql, params) => {
    const s = sql.replace(/\s+/g, " ").trim().toLowerCase();

    // ── Geração de protocolo (nextval) ─────────────────────────────────────
    if (s.includes("nextval") && s.includes("protocolo_seq")) {
      _ticketCounter++;
      return { rows: [{ numero: _ticketCounter }], rowCount: 1 };
    }

    // ── Sessions ──────────────────────────────────────────────────────────
    if (s.startsWith("insert into sessions")) {
      _dbSessions[params[0]] = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("delete from sessions where user_id")) {
      delete _dbSessions[params[0]];
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("from sessions")) {
      return { rows: [], rowCount: 0 };
    }

    // ── Tickets: INSERT ───────────────────────────────────────────────────
    if (s.startsWith("insert into tickets")) {
      // Encontra o protocolo já gerado nos params (vem da gerarProtocolo())
      const protocolo = (params || []).find(p => typeof p === "string" && /^\d{4}-\d{4}$/.test(p))
        || `2026-${String(_ticketCounter).padStart(4, "0")}`;
      const row = {
        id:            1,
        protocolo,
        user_id:       (params || [])[0],
        type:          (params || [])[1],
        sector:        (params || [])[2],
        customer_name: (params || [])[3] || "Teste",
        cpf:           null,
        description:   (params || [])[5] || (params || [])[4] || "",
        status:        "aberto",
        created_at:    new Date(),
        updated_at:    new Date(),
      };
      return { rows: [row], rowCount: 1 };
    }

    // ── History ───────────────────────────────────────────────────────────
    if (s.includes("from history"))       return { rows: [], rowCount: 0 };
    if (s.startsWith("insert into history")) return { rows: [{ id: 1 }], rowCount: 1 };
    if (s.startsWith("update history"))   return { rows: [], rowCount: 0 };

    // ── Settings / botconfig ──────────────────────────────────────────────
    if (s.includes("from settings")) {
      return { rows: [{ id: 1, data: JSON.stringify({ iaAtiva: true, timeoutAviso: 7, timeoutEncerramento: 15 }) }], rowCount: 1 };
    }

    // ── Misc ──────────────────────────────────────────────────────────────
    if (s.includes("processed_messages")) return { rows: [], rowCount: 0 };
    if (s.includes("quick_responses"))    return { rows: [], rowCount: 0 };
    if (s.includes("from logs"))          return { rows: [], rowCount: 0 };
    if (s.includes("from tickets"))       return { rows: [], rowCount: 0 };

    return { rows: [], rowCount: 0 };
  }
};

// ─── Injeta mock ANTES de qualquer require do projeto ──────────────────────
require.cache[require.resolve("./src/database/postgres")] = {
  id: require.resolve("./src/database/postgres"),
  filename: require.resolve("./src/database/postgres"),
  loaded: true,
  exports: poolMock,
};

// ─── Mock: IA (respostas controláveis por cenário) ──────────────────────────
let _iaMockFn = null;   // se definido, usa ele; senão usa default
const aiMock = {
  // O fluxo consulta o circuit breaker mesmo quando a chamada da IA é
  // simulada. No teste ele está desligado; falhas são controladas por
  // _iaMockFn e devem percorrer o fallback normal após duas tentativas.
  iaEmFalhaCritica: () => false,
  perguntarIA: async (msg, opts) => {
    if (_iaMockFn) return _iaMockFn(msg, opts);
    const m = msg.toLowerCase();
    if (/sensor|filtro|alternador|farol|bateria|peça|motor|fusível|chave|cabo|lâmpada/.test(m))
      // pedidoExplicito: true — este mock representa uma IA real classificando
      // uma menção direta de peça ("preciso de X") como pedido explícito, não
      // uma pergunta de disponibilidade (ver PERGUNTA_DISPONIBILIDADE_RE em
      // main.flow.js — mensagens terminadas em "?" com "tem"/"vocês têm" etc.
      // são REBAIXADAS pra false por segurança, mesmo com pedidoExplicito
      // aqui true — isso é intencional, ver ticket #2026-0056/#2026-0068).
      return { resposta: "Sim, trabalhamos com esse item! Posso te ajudar a solicitar um orçamento. 😊", intencao: "vendas", pedidoExplicito: true };
    // "crediario" removido como intenção própria (2026-07-24) — dobrado
    // dentro de "gestao" (ver ai.service.js): menção a crediário/parcelamento
    // agora direciona pro telefone direto do setor (MSG.outrosContatos).
    if (/crediário|parcelar|prazo|parcela/.test(m))
      return { resposta: "Temos crediário próprio para nossos clientes!", intencao: "gestao" };
    if (/atendente|vendedor|humano|pessoa/.test(m))
      return { resposta: "Claro, vou te conectar com um atendente!", intencao: "atendente" };
    if (/gerente|reclamação|gestão|problema grave/.test(m))
      // "gestao" não cria mais ticket — direciona pro contato direto (ver
      // MSG.outrosContatos em messages.js, decisão do usuário 2026-07-21).
      return { resposta: "Entendo sua situação!", intencao: "gestao" };
    return { resposta: "Olá! Como posso te ajudar? 😊", intencao: "chat" };
  }
};
require.cache[require.resolve("./src/services/ai.service")] = {
  id: require.resolve("./src/services/ai.service"),
  loaded: true,
  exports: aiMock,
};

// ─── Mock: notificações ──────────────────────────────────────────────────────
const notifMock = {
  notificarAtendente: () => {},
  notificarSeDisponivel: () => {},
};
require.cache[require.resolve("./src/services/notificacao.service")] = {
  id: require.resolve("./src/services/notificacao.service"),
  loaded: true,
  exports: notifMock,
};

// ─── Mock: humanMode ─────────────────────────────────────────────────────────
require.cache[require.resolve("./src/services/humanMode.service")] = {
  id: require.resolve("./src/services/humanMode.service"),
  loaded: true,
  exports: { estaAtivo: () => false, ativar: () => {}, desativar: () => {} },
};

// ─── Carrega o mainFlow DEPOIS dos mocks ────────────────────────────────────
const mainFlow = require("./src/flows/main.flow");
const { getSession, clearSession } = require("./src/services/session.service");

// ─── Helpers de output ───────────────────────────────────────────────────────
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

let _passed = 0, _failed = 0, _warnings = 0;
const _allIssues = [];

function titulo(t) { console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}\n${BOLD}${CYAN}  ${t}${RESET}\n${CYAN}${"═".repeat(60)}${RESET}`); }
function subtitulo(t) { console.log(`\n${BOLD}  ▶ ${t}${RESET}`); }
function ok(label) { _passed++; console.log(`  ${GREEN}✓${RESET} ${label}`); }
function fail(label, detail) { _failed++; _allIssues.push({ type:"FALHA", label, detail }); console.log(`  ${RED}✗ FALHA${RESET} ${label}`); if (detail) console.log(`    ${DIM}${detail}${RESET}`); }
function warn(label, detail) { _warnings++; _allIssues.push({ type:"AVISO", label, detail }); console.log(`  ${YELLOW}⚠ AVISO${RESET} ${label}`); if (detail) console.log(`    ${DIM}${detail}${RESET}`); }
function msgBot(label, resp) {
  const preview = resp ? resp.replace(/\n/g, " ↵ ").slice(0, 120) : "(null)";
  console.log(`  ${DIM}  [${label}] → "${preview}${resp?.length > 120 ? "…" : ""}"${RESET}`);
}

// ─── Simulador de conversa ───────────────────────────────────────────────────
const USER_ID = "5579999999999@test.us";

async function enviar(msg, label) {
  const resp = await mainFlow({ userId: USER_ID, message: msg });
  if (label) msgBot(label, resp);
  return resp;
}

async function resetarSessao() {
  await clearSession(USER_ID);
}

// ─── Asserções ───────────────────────────────────────────────────────────────
function contem(resp, texto, label) {
  if (resp && resp.includes(texto)) { ok(label); return true; }
  fail(label, `Esperado conter: "${texto}" | Recebido: "${resp?.slice(0,100)}"`);
  return false;
}
function naoContem(resp, texto, label) {
  if (!resp || !resp.includes(texto)) { ok(label); return true; }
  fail(label, `Não deveria conter: "${texto}" | Recebido: "${resp?.slice(0,100)}"`);
  return false;
}
function existeEmoji(resp, emoji, label) {
  if (resp && resp.includes(emoji)) { ok(label); return true; }
  fail(label, `Emoji "${emoji}" não encontrado | Recebeu: "${resp?.slice(0,150)}"`);
  return false;
}
function naoNulo(resp, label) {
  if (resp) { ok(label); return true; }
  fail(label, "Resposta foi null/undefined");
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 1 — Menu principal
// ════════════════════════════════════════════════════════════════════════════
async function testMenuPrincipal() {
  titulo("SUITE 1 — Menu Principal e Saudações");

  subtitulo("Saudações que abrem o menu");
  const entradas = ["oi", "Oi!", "OI", "0", "menu", "Bom dia!", "boa tarde", "Ola", "voltar", "inicio", "cancelar"];
  for (const msg of entradas) {
    await resetarSessao();
    const r = await enviar(msg, msg);
    contem(r, "Rildon Eletropeças", `"${msg}" → abre menu`);
    existeEmoji(r, "1", `"${msg}" → emoji 1 correto`);
    existeEmoji(r, "2", `"${msg}" → emoji 2 correto`);
  }

  subtitulo("Encerramento");
  await resetarSessao();
  const rEnc = await enviar("tchau", "tchau");
  contem(rEnc, "Atendimento encerrado", "tchau → mensagem de encerramento");
  contem(rEnc, "Rildon Eletropeças", "tchau → menciona empresa");

  subtitulo("Opção 3 — Horário (renumerada de 4 após remoção do Crediário, 2026-07-24)");
  await resetarSessao();
  const rHor = await enviar("3", "3=horário");
  contem(rHor, "07:50", "opção 3 → mostra horário");

  subtitulo("Opção 4 — inválida → IA responde (Crediário removido do menu, 2026-07-24)");
  await resetarSessao();
  _iaMockFn = () => ({ resposta: "Não entendi. Como posso ajudar?", intencao: "chat" });
  const rProt = await enviar("4", "4 não existe mais → IA");
  _iaMockFn = null;
  naoContem(rProt, "Crediário", "opção 4 (antigo Crediário) removida do menu");
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 2 — Fluxo de Vendas / Orçamento completo
// ════════════════════════════════════════════════════════════════════════════
async function testVendas() {
  titulo("SUITE 2 — Vendas / Orçamento");

  subtitulo("Fluxo completo: menu → direto no formulário");
  await resetarSessao();

  const r1 = await enviar("1", "opção 1 = entra direto no form");
  naoNulo(r1, "opção 1 → resposta não nula");
  contem(r1, "nome", "opção 1 → pede nome direto (sem submenu)");

  const r3 = await enviar("João Silva", "nome");
  contem(r3, "veículo", "pede veículo após nome");

  const r4 = await enviar("VW Gol 2015", "veículo");
  contem(r4, "peça", "pede peça/serviço após veículo");

  const r5 = await enviar("Sensor MAP", "produto");
  naoNulo(r5, "orçamento finalizado");
  contem(r5, "🎫", "mensagem com protocolo (ticket)");
  contem(r5, "consultor entrará em contato", "mensagem de fechamento natural");
  naoContem(r5, "Como posso ajudar você hoje", "não re-abre o menu principal");

  subtitulo("Nome já salvo → pula etapa de nome direto para veículo");
  await resetarSessao();
  const { updateSession: updSess } = require("./src/services/session.service");
  await updSess(USER_ID, { customerName: "Hickson Martins" });
  // Agora opção "1" no menu principal vai DIRETO ao formulário (sem submenu vendas)
  const rPulaNome = await enviar("1", "solicitar orçamento com nome já salvo");
  contem(rPulaNome, "Hickson", "reconhece o nome salvo");
  contem(rPulaNome, "veículo", "pula nome e pede veículo diretamente");
  naoContem(rPulaNome, "nome completo", "não pede nome novamente");

  subtitulo("'pular' no campo de veículo");
  await resetarSessao();
  await enviar("1", null);
  await enviar("1", null);
  await enviar("Maria Oliveira", null);
  const rPular = await enviar("pular", "pular veículo");
  contem(rPular, "peça", "pular aceito no veículo");
  const rFimPular = await enviar("Alternador Bosch", null);
  contem(rFimPular, "🎫", "orçamento ok com pular");


  subtitulo("Escape do fluxo de orçamento");
  await resetarSessao();
  await enviar("1", null);
  await enviar("1", null);
  await enviar("Carlos", null);
  const rEsc = await enviar("0", "cancelar com 0");
  contem(rEsc, "Rildon Eletropeças", "0 dentro do form → volta ao menu");
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 4 — Atendente e Gestão
// ════════════════════════════════════════════════════════════════════════════
async function testAtendenteGestao() {
  titulo("SUITE 4 — Atendente e Gestão");

  subtitulo("Atendente humano via IA (intent=atendente)");
  await resetarSessao();
  // Atendente não tem opção direta no menu — é roteado pela IA quando intent=atendente
  _iaMockFn = () => ({ resposta: "Claro, vou te conectar com um atendente agora!", intencao: "atendente" });
  const rAte = await enviar("preciso falar com uma pessoa", "intent atendente via IA");
  _iaMockFn = null;
  contem(rAte, "descreva", "pede motivo para atendente");

  const rFimAte = await enviar("Preciso de ajuda com sensor de temperatura", "motivo atendente");
  contem(rFimAte, "Protocolo", "atendente registrado");
  contem(rFimAte, "Posso ajudar", "fechamento natural atendente");

  subtitulo("Opção 2 — Outros Contatos (renumerada de 3 após remoção do Crediário, lista estática, sem ticket)");
  await resetarSessao();
  const rContatos = await enviar("2", "opção 2 do menu");
  contem(rContatos, "Outros Contatos", "mostra o título da lista");
  contem(rContatos, "Ouvidoria", "lista inclui contato de Ouvidoria");
  contem(rContatos, "Crediário", "lista inclui telefone direto de Crediário (fluxo próprio descontinuado, 2026-07-24)");

  subtitulo("IA detecta 'gestao' (reclamação) — mostra contatos, sem criar ticket");
  await resetarSessao();
  _iaMockFn = () => ({ resposta: "Entendo sua situação!", intencao: "gestao" });
  const rGest = await enviar("quero falar com o gerente, tive um problema grave", "intent gestao via IA");
  _iaMockFn = null;
  contem(rGest, "Outros Contatos", "intent gestao direciona pra lista de contatos");
  naoContem(rGest, "Protocolo", "não cria ticket pra reclamação/gestão");
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 5 — Comportamento da IA e roteamento
// ════════════════════════════════════════════════════════════════════════════
async function testIA() {
  titulo("SUITE 5 — IA e Roteamento por Intenção");

  subtitulo("IA detecta 'vendas' — primeira entrada → entra direto no formulário de orçamento");
  await resetarSessao();
  const rV1 = await enviar("preciso de um alternador", "ia vendas nova entrada");
  contem(rV1, "orçamento", "IA 'vendas' nova entrada → resposta menciona orçamento");
  contem(rV1, "nome completo", "sem nome salvo, formulário pede nome completo");
  naoContem(rV1, "Para solicitar orçamento, escolha a opção", "não deve mostrar dica sutil na primeira entrada");

  subtitulo("IA detecta 'vendas' — mensagem seguinte já é tratada como etapa do formulário");
  // userId já está em sector=vendas/aguardando_nome pela mensagem anterior — a próxima
  // mensagem é consumida pelo formulário (como nome), não roteada de novo pela IA.
  const r2V = await enviar("e sensor de map, vocês têm?", "ia vendas contexto existente");
  naoContem(r2V, "🛒 *Vendas / Orçamento*", "não repete menu completo em contexto de vendas");
  contem(r2V, "veículo", "avança para a etapa de veículo do formulário");

  subtitulo("Intenção 'vendas' + pedido explícito via IA sempre entra no formulário (não há mais chat livre dentro do setor)");
  await resetarSessao();
  // "quero comprar" (pedido explícito) em vez de "vocês têm bateria?" —
  // uma pergunta de disponibilidade (regex PERGUNTA_DISPONIBILIDADE_RE em
  // main.flow.js) é rebaixada pra pedidoExplicito=false por segurança
  // independente do que a IA classificar, então não serviria pra este
  // cenário (ver ticket #2026-0056/#2026-0068 — downgrade intencional).
  _iaMockFn = () => ({ resposta: "Temos sim! Para orçamento, escolha a opção 1.", intencao: "vendas", pedidoExplicito: true });
  await enviar("quero comprar uma bateria", null);  // IA roteia para vendas e já define a etapa (aguardando_nome)
  _iaMockFn = () => ({ resposta: "Sim, temos filtros de ar de diversas marcas! 🔧", intencao: "vendas" });
  const rFiltro = await enviar("filtros brasil", "texto livre em vendas — consumido como nome do formulário");
  _iaMockFn = null;
  naoContem(rFiltro, "Como posso ajudar?", "texto livre em vendas → não exibe sub-menu direto");
  contem(rFiltro, "veículo", "nome aceito, formulário avança para veículo");

  subtitulo("IA chat — sem menu forçado ao final");
  await resetarSessao();
  _iaMockFn = () => ({ resposta: "Nosso horário é de segunda a sexta das 07:50 às 17:50! 😊", intencao: "chat" });
  const rChat = await enviar("qual o horário de vocês?", "ia chat");
  _iaMockFn = null;
  naoContem(rChat, "_Digite *0* para ver o menu de opções._", "IA chat não força '_Digite 0_' ao final");
  contem(rChat, "07:50", "IA chat responde corretamente");

  subtitulo("IA detecta menção a crediário (dobrado em 'gestao', 2026-07-24) → direciona pra Outros Contatos, sem criar ticket");
  await resetarSessao();
  const rCred = await enviar("quero parcelar minha compra", "ia crediário");
  contem(rCred, "Outros Contatos", "IA crediário/gestao → lista de contatos diretos");
  naoContem(rCred, "Protocolo", "não cria ticket pra menção de crediário");

  subtitulo("IA detecta 'atendente'");
  await resetarSessao();
  const rAte = await enviar("quero falar com um atendente por favor", "ia atendente");
  contem(rAte, "descreva", "IA atendente → pede motivo");

  subtitulo("IA falha → fallback após 2 erros");
  await resetarSessao();
  _iaMockFn = () => null;
  await enviar("mensagem qualquer sem IA", null);
  const rFallback = await enviar("mais uma mensagem", "2ª falha IA");
  _iaMockFn = null;
  contem(rFallback, "dificuldades técnicas", "2 falhas de IA → mensagem de dificuldade técnica");
  existeEmoji(rFallback, "2", "fallback técnico → emoji 2 ok");
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 6 — Edge cases e validações
// ════════════════════════════════════════════════════════════════════════════
async function testEdgeCases() {
  titulo("SUITE 6 — Edge Cases e Validações");

  subtitulo("Nome inválido (muito curto)");
  await resetarSessao();
  await enviar("1", null); await enviar("1", null);
  const rNomeInv = await enviar("Jo", "nome muito curto");
  contem(rNomeInv, "nome", "rejeita nome curto");

  subtitulo("Nome com apelido (só 1 parte)");
  await resetarSessao();
  await enviar("1", null); await enviar("1", null);
  const rApelido = await enviar("Rildon", "apelido de 6 chars");
  // Deve aceitar (validarNome aceita nomes ≥3 chars sem espaço)
  const sessApelido = getSession(USER_ID);
  if (sessApelido.step === "aguardando_veiculo") ok("apelido aceito → avança para veículo");
  else warn("apelido pode ter sido rejeitado", `step=${sessApelido.step} | resp="${rApelido?.slice(0,80)}"`);

  subtitulo("Descrição de orçamento muito curta (< 5 chars)");
  await resetarSessao();
  await enviar("1", null); await enviar("1", null);
  await enviar("Pedro Santos", null); await enviar("pular", null);
  const rDescCurta = await enviar("abs", "descrição curta");
  contem(rDescCurta, "descreva melhor", "rejeita descrição muito curta");

  subtitulo("Mensagem com pontuação no menu (Bom dia!)");
  await resetarSessao();
  const rBomDia = await enviar("Bom dia!", "Bom dia!");
  contem(rBomDia, "Rildon Eletropeças", "'Bom dia!' → abre menu (pontuação ignorada)");

  subtitulo("Mensagem vazia / só espaços");
  await resetarSessao();
  const rVazio = await enviar("   ", "espaços");
  naoNulo(rVazio, "mensagem vazia → resposta não nula");

  subtitulo("Consulta de protocolo direta");
  await resetarSessao();
  const rProtocolo = await enviar("#2026-0001", "protocolo inexistente");
  naoNulo(rProtocolo, "consulta protocolo → não retorna null");
  contem(rProtocolo, "Nenhum ticket encontrado", "protocolo inexistente → avisa corretamente");

  subtitulo("Sector inválido na sessão → reset automático");
  await resetarSessao();
  const { updateSession: upd } = require("./src/services/session.service");
  await upd(USER_ID, { sector: "setor_inexistente", step: "step_invalido" });
  const rInvalid = await enviar("oi", "sector inválido");
  contem(rInvalid, "Rildon Eletropeças", "sector inválido → reseta para menu");

  subtitulo("Opções inválidas no menu principal (7, 9, abc)");
  for (const op of ["7", "9", "abc", "???"]) {
    await resetarSessao();
    _iaMockFn = () => ({ resposta: "Não entendi, pode repetir?", intencao: "chat" });
    const r = await enviar(op, `opção inválida "${op}"`);
    _iaMockFn = null;
    naoNulo(r, `"${op}" → bot responde algo`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 7 — Fluxo pós-conclusão (re-entrada natural)
// ════════════════════════════════════════════════════════════════════════════
async function testPosFluxo() {
  titulo("SUITE 7 — Pós-fluxo e Re-entrada Natural");

  subtitulo("Após orçamento → próxima mensagem não re-exibe menu de vendas agressivamente");
  await resetarSessao();
  await enviar("1", null); await enviar("1", null);
  await enviar("Lucas Martins", null); await enviar("pular", null);
  const rOrc = await enviar("Sensor de temperatura", null);
  contem(rOrc, "🎫", "orçamento concluído");
  contem(rOrc, "consultor entrará em contato", "mensagem de fechamento presente");

  // Sessão foi limpa — próxima mensagem deve abrir normalmente
  _iaMockFn = () => ({ resposta: "Claro! Posso te ajudar com isso.", intencao: "chat" });
  const rProx = await enviar("obrigado!", "mensagem pós-orçamento");
  _iaMockFn = null;
  naoContem(rProx, "🛒 *Vendas / Orçamento*", "pós-orçamento: 'obrigado!' não re-exibe menu vendas");

  subtitulo("Encerrar → reabertura com saudação");
  await resetarSessao();
  await enviar("encerrar", null);
  const rReabrir = await enviar("oi", "reabertura");
  contem(rReabrir, "Rildon", "reabertura após encerrar → menu ok");

  subtitulo("Sequência longa — vendas → 0 → outros contatos → cancelar → atendente via IA");
  await resetarSessao();
  await enviar("1", null);  // formulário de orçamento
  await enviar("0", null);  // volta ao menu
  await enviar("2", null);  // outros contatos (renumerada de crediário, 2026-07-24) — resposta estática, sem sector
  const rV2 = await enviar("cancelar", "'cancelar' após Outros Contatos");
  contem(rV2, "Rildon", "cancelar → menu principal");
  // Atendente não tem opção direta no menu — é acionado pela IA (intent=atendente)
  _iaMockFn = () => ({ resposta: "Claro! Vou te conectar com um atendente.", intencao: "atendente" });
  await enviar("quero falar com um atendente", null);
  _iaMockFn = null;
  const rFimSeq = await enviar("Quero saber sobre garantia", "motivo atendente");
  contem(rFimSeq, "Protocolo", "sequência longa → atendente ok");
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 8 — Personas variadas (sessão de testes solicitada pelo usuário)
// ════════════════════════════════════════════════════════════════════════════
async function testPersonas() {
  titulo("SUITE 8 — Personas Variadas");

  subtitulo("Persona 'apressada' — confirma orçamento com 'Sim!' (pontuação) em vez de 'sim' exato");
  await resetarSessao();
  _iaMockFn = () => ({ resposta: "Sim, trabalhamos com alternador!", intencao: "vendas" }); // pedidoExplicito ausente/false → cai na confirmação
  await enviar("preciso de um alternador pro meu gol", "consulta inicial (sem pedidoExplicito)");
  _iaMockFn = null;
  const rConfirmaPontuacao = await enviar("Sim!", "confirma com pontuação");
  contem(rConfirmaPontuacao, "nome completo", "'Sim!' deveria confirmar o orçamento igual a 'sim' exato");

  subtitulo("Persona 'atropelada' — manda nome+veículo+peça de uma vez só quando só o nome foi pedido");
  await resetarSessao();
  await enviar("1", null);
  await enviar("1", null);
  const rAtropela = await enviar("João Silva, Fiat Uno 2015, preciso de um alternador", "nome atropelado (tudo junto)");
  naoNulo(rAtropela, "não trava com mensagem atropelada");

  subtitulo("Persona 'muda de assunto no meio do formulário' — pergunta de crediário na etapa de veículo");
  await resetarSessao();
  await enviar("1", null);
  await enviar("1", null);
  await enviar("Maria Souza", null);
  const rMudaAssunto = await enviar("vocês fazem crediário também?", "mudança de assunto na etapa de veículo");
  contem(rMudaAssunto, "outro assunto", "detecta mudança de assunto no meio do formulário de vendas");

  // Substitui a antiga persona "CPF errado várias vezes" (dependia do
  // sub-fluxo de crediário — nome→CPF→motivo — descontinuado em
  // 2026-07-24). Preserva a mesma intenção de cobertura (entrada inválida
  // repetida não trava o fluxo) usando o campo de nome do formulário de
  // vendas, que ainda existe.
  subtitulo("Persona 'nome inválido várias vezes' — 3 tentativas curtas seguidas antes de acertar");
  await resetarSessao();
  await enviar("1", null);
  await enviar("1", null);
  const rNome1 = await enviar("Jo", "nome inválido tentativa 1 (muito curto)");
  contem(rNome1, "nome", "rejeita 1ª tentativa");
  const rNome2 = await enviar("X", "nome inválido tentativa 2 (1 char)");
  contem(rNome2, "nome", "rejeita 2ª tentativa");
  const rNome3 = await enviar("Zz", "nome inválido tentativa 3 (2 chars)");
  contem(rNome3, "nome", "rejeita 3ª tentativa");
  const rNomeOk = await enviar("Pedro Alves", "nome válido na 4ª tentativa");
  contem(rNomeOk, "veículo", "aceita nome válido após 3 tentativas erradas, não trava o fluxo");
}

// ════════════════════════════════════════════════════════════════════════════
// SUITE 9 — Personas Variadas II
// ════════════════════════════════════════════════════════════════════════════
async function testPersonas2() {
  titulo("SUITE 9 — Personas Variadas II");

  subtitulo("Persona 'digita opção do menu com pontuação' — '1.', '2)', '3!'");
  await resetarSessao();
  const rMenuPonto1 = await enviar("1.", "'1.' no menu principal");
  contem(rMenuPonto1, "nome", "'1.' deveria entrar no form de orçamento igual a '1'");

  await resetarSessao();
  const rMenuPonto2 = await enviar("2)", "'2)' no menu principal");
  contem(rMenuPonto2, "Outros Contatos", "'2)' deveria mostrar Outros Contatos igual a '2'");

  subtitulo("Persona 'volta duas vezes seguidas' — '0' repetido sem digitar nada no meio");
  await resetarSessao();
  const rZero1 = await enviar("0", "1º '0'");
  contem(rZero1, "Rildon Eletropeças", "1º '0' → menu");
  const rZero2 = await enviar("0", "2º '0' seguido");
  contem(rZero2, "Rildon Eletropeças", "2º '0' seguido → menu de novo, sem travar");

  subtitulo("Persona 'confirma orçamento com emoji' — '👍' não é 'sim'/'1', não deve confirmar sozinho");
  await resetarSessao();
  _iaMockFn = () => ({ resposta: "Sim, trabalhamos com alternador!", intencao: "vendas" });
  await enviar("preciso de um alternador pro meu gol", "consulta inicial (sem pedidoExplicito)");
  _iaMockFn = () => ({ resposta: "Entendi! 😊", intencao: "chat" });
  const rEmoji = await enviar("👍", "confirma só com emoji (não é 'sim'/'1')");
  _iaMockFn = null;
  naoContem(rEmoji, "🎫", "emoji sozinho não finaliza orçamento sem confirmação textual explícita");

  subtitulo("Persona 'manda mensagem gigante' — 600+ caracteres como veículo, não deve travar");
  await resetarSessao();
  await enviar("1", null);
  await enviar("1", null);
  await enviar("Roberto Ferreira", null);
  const textoGigante = "Fiat Uno 2015 branco comprado usado ano passado ".repeat(15);
  const rGigante = await enviar(textoGigante, "mensagem de 600+ chars no campo veículo");
  naoNulo(rGigante, "mensagem gigante → não trava/crasha");
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${BOLD}${CYAN}╔${"═".repeat(58)}╗`);
  console.log(`║  🤖  Simulador de Conversa — Bot Rildon Eletropeças    ║`);
  console.log(`╚${"═".repeat(58)}╝${RESET}`);
  console.log(`${DIM}Suite: ${SUITE_ARG === "all" ? "TODAS" : SUITE_ARG.toUpperCase()}${RESET}`);

  const suites = {
    menu:      testMenuPrincipal,
    vendas:    testVendas,
    atendente: testAtendenteGestao,
    ia:        testIA,
    edge:      testEdgeCases,
    posfluxo:  testPosFluxo,
    personas:  testPersonas,
    personas2: testPersonas2,
  };

  if (SUITE_ARG === "all") {
    for (const fn of Object.values(suites)) await fn();
  } else {
    const fn = suites[SUITE_ARG];
    if (!fn) { console.error(`Suite desconhecida: ${SUITE_ARG}. Opções: ${Object.keys(suites).join(", ")}`); process.exit(1); }
    await fn();
  }

  // ── Relatório final ─────────────────────────────────────────────────────
  const total = _passed + _failed;
  const cor = _failed > 0 ? RED : GREEN;
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}  RESULTADO FINAL${RESET}`);
  console.log(`${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`  ${GREEN}✓ Passou:  ${_passed}${RESET}`);
  console.log(`  ${RED}✗ Falhou:  ${_failed}${RESET}`);
  console.log(`  ${YELLOW}⚠ Avisos:  ${_warnings}${RESET}`);
  console.log(`  Total:    ${total}`);
  console.log(`  Taxa:     ${cor}${(((_passed)/Math.max(total,1))*100).toFixed(0)}%${RESET}`);

  if (_allIssues.length > 0) {
    console.log(`\n${BOLD}  Issues encontradas:${RESET}`);
    for (const iss of _allIssues) {
      const icone = iss.type === "FALHA" ? `${RED}✗` : `${YELLOW}⚠`;
      console.log(`  ${icone} ${iss.label}${RESET}`);
      if (iss.detail) console.log(`    ${DIM}${iss.detail}${RESET}`);
    }
  }

  console.log(`\n${_failed === 0 ? `${GREEN}${BOLD}  ✅ Todos os testes passaram!${RESET}` : `${RED}${BOLD}  ❌ ${_failed} teste(s) falharam — verifique issues acima.${RESET}`}\n`);
  process.exit(_failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\n${RED}ERRO FATAL no simulador:${RESET}`, err);
  process.exit(1);
});
