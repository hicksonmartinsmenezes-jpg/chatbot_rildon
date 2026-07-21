const { updateSession, clearSession, finalizarComTicket }    = require("../services/session.service");
const { createTicket }                                      = require("../services/ticket.service");
const { validarNome, validarTamanho, mensagemTamanhoInvalido,
        sanitizarTexto, normalizar }                        = require("../utils/validators");
const { notificarAtendente }                                = require("../services/notificacao.service");
const logger                                                = require("../utils/logger");
const MSG                                                   = require("./messages");

const MSG_TICKET_FALHOU =
  "⚠️ Não consegui registrar sua solicitação agora.\n\n" +
  "Por favor, ligue diretamente: *(79) 99135-3569*\n\n" +
  "_Digite *0* para voltar ao menu._";

async function _criarTicketVendas(dados) {
  try {
    const ticket = await createTicket(dados);
    if (!ticket) throw new Error("createTicket retornou nulo");
    return ticket;
  } catch (err) {
    logger.error(`[vendas._criarTicket] ${err.message}`);
    return null;
  }
}

// Finaliza o orçamento: monta a descrição (veículo + produto),
// cria o ticket e encerra a sessão preservando o histórico da IA (ver
// finalizarComTicket em session.service.js — corrige o bug de perguntas
// de acompanhamento tipo "quando?" perderem contexto).
async function _finalizarOrcamento(userId, session, veiculo, produtoTexto) {
  const veiculoPrefix = veiculo && veiculo !== "Não informado" ? `Veículo: ${veiculo} | ` : "";
  const descricao      = `${veiculoPrefix}Produto: ${produtoTexto}`;

  const ticket = await _criarTicketVendas({
    userId,
    type:         "orcamento",
    customerName: session.customerName || MSG.NAO_INFORMADO,
    description:  descricao,
  });
  await finalizarComTicket(userId, ticket);
  if (!ticket) return MSG_TICKET_FALHOU;
  notificarAtendente(ticket);
  return MSG.vendas.ORCAMENTO_SOLICITADO(ticket);
}

// Palavras que escapam para o menu principal em qualquer etapa de coleta
const ESCAPE = new Set(["0", "menu", "voltar", "cancelar", "inicio"]);

// BUG REAL (relatado pelo usuário, testes de edge-case): as etapas de coleta
// (nome/veículo/orçamento) aceitam QUALQUER texto não-vazio como resposta,
// sem checagem semântica — reproduzido enviando "meu cpf e 123.456.789-01,
// pode confirmar meu cadastro?" como resposta a "qual peça você precisa?",
// que foi salvo verbatim no campo errado (descrição do ticket) e nunca
// respondeu à pergunta real do cliente sobre o cadastro. Este check é
// deliberadamente ESTREITO (menciona "cpf" E TEM 11 dígitos seguidos) pra
// não dar falso positivo em números de telefone legítimos (também 11
// dígitos) que não mencionam CPF.
function _pareceCPFOuDadoPessoal(message) {
  const normalizado     = normalizar(message);
  const somenteDigitos  = message.replace(/\D/g, "");
  const mencionaCPF     = /\bcpf\b/.test(normalizado);
  const tem11DigitosSeguidos = /\d{11}/.test(somenteDigitos);
  return mencionaCPF && tem11DigitosSeguidos;
}

// BUG REAL (relatado pelo usuário, testes de edge-case — reproduzido ao
// vivo: cliente perguntou "na verdade, voces fazem crediario?" na etapa
// "qual peça você precisa?" e a pergunta virou literalmente a peça do
// ticket, nunca sendo respondida): assim como o CPF, o cliente pode mudar
// de assunto no meio da coleta pedindo algo de OUTRO setor. Detecta menções
// claras a esses outros assuntos — deliberadamente restrito a palavras-chave
// sem relação com nome/veículo/peça, pra não recusar respostas legítimas
// (ex: "tem pastilha pro gol 2018?" continua sendo aceito normalmente,
// mesmo tendo "?" e sendo uma pergunta).
const MUDANCA_ASSUNTO_RE =
  /\bcrediari\w*\b|\bfinanciamento\b|\bparcelamento\b|\bhorario de funcionamento\b|\bque horas (abre|fecha)\b|\bonde fica\b|\bendereco\b|\blocalizacao\b|\bfalar com a equipe\b|\bfalar com o responsavel\b|\breclamacao\b|\bquero reclamar\b/;

function _pareceMudancaDeAssunto(message) {
  const normalizado = normalizar(message);
  return MUDANCA_ASSUNTO_RE.test(normalizado);
}

// BUG REAL (achado em teste ao vivo, 2026-07-21, testando o Claude Haiku
// 4.5 recém-ativado como provedor): na etapa "qual o veículo?", se o
// cliente corrige a PEÇA que quer em vez de responder com o veículo (ex:
// "na verdade nem era alternador não, era uma pastilha de freio mesmo"),
// o código tratava a frase inteira como se fosse o veículo — o ticket
// saiu com "Veículo: na verdade nem era alternador não, era uma pastilha
// de freio mesmo" e a peça antiga (errada) ainda como "alternador".
// Diferente de _pareceMudancaDeAssunto acima (que pega troca pra OUTRO
// SETOR, tipo crediário), aqui o cliente continua em vendas, só mudou de
// ideia sobre qual peça — não existe forma 100% confiável de distinguir
// isso de uma resposta de veículo via regex, então o check é deliberada-
// mente restrito a marcadores explícitos de correção ("na verdade",
// "mudei de ideia", "me enganei", "quis dizer", "esquece", "errei"), que
// dificilmente aparecem numa resposta legítima de veículo.
const CORRECAO_PECA_RE =
  /\bna verdade\b|\bmudei de ideia\b|\bme enganei\b|\bquis dizer\b|\bpera(i|)\b.*\besquece\b|\besquece\b.*\bera\b|\berrei\b/;

function _pareceCorrecaoDePeca(message) {
  const normalizado = normalizar(message);
  return CORRECAO_PECA_RE.test(normalizado);
}

async function vendasFlow(message, userId, session) {
  const msg           = normalizar(sanitizarTexto(message));
  const msgSemPontos  = msg.replace(/[^\p{L}\p{N}\s]/gu, "").trim();

  if (session.sector === "vendas") {

    // ── Escape universal: volta ao menu em qualquer etapa ──────────────────────
    if (ESCAPE.has(msg) || ESCAPE.has(msgSemPontos)) {
      await clearSession(userId);
      return null; // mainFlow exibirá o menu principal
    }

    // ── Bloqueia CPF/dado pessoal sensível em qualquer etapa de coleta ─────────
    if (session.step && _pareceCPFOuDadoPessoal(message)) {
      logger.warn(`[vendasFlow] Mensagem com CPF/dado pessoal recusada — userId=${userId} step=${session.step}`);
      return (
        "⚠️ Por aqui não coletamos CPF nem outros dados pessoais sensíveis — não precisamos disso pra esta etapa.\n\n" +
        "Pode repetir sua resposta sem incluir esse tipo de informação?" +
        MSG.ESCAPE_DICA
      );
    }

    // ── Detecta mudança de assunto (cliente pergunta sobre outro setor) ────────
    if (session.step && _pareceMudancaDeAssunto(message)) {
      logger.warn(`[vendasFlow] Mudança de assunto detectada, saindo do fluxo de vendas — userId=${userId} step=${session.step} msg="${message}"`);
      await clearSession(userId);
      return (
        "Percebi que sua pergunta é sobre outro assunto! 😊\n\n" +
        "Digite *0* para ver o menu principal e escolher a opção certa (crediário, outros contatos, horário, etc.)."
      );
    }

    // ── Etapa 1: Nome ──────────────────────────────────────────────────────────
    if (session.step === "aguardando_nome") {
      if (!validarNome(sanitizarTexto(message))) {
        return MSG.NOME_INVALIDO + MSG.ESCAPE_DICA;
      }
      const nomeSanitizado = sanitizarTexto(message);

      // Pedido do usuário: se a IA já identificou o veículo na mensagem
      // inicial (ex: "motor de partida fiat palio 2025" → veiculoInicial=
      // "Fiat Palio 2025", setado em main.flow.js), não repete a pergunta
      // "qual o veículo?" — já temos peça + veículo, faltava só o nome.
      // pecaInicial (nome limpo da peça, ex: "Motor de partida") é
      // preferido a produtoInicial (a frase inteira do cliente, com
      // saudação e tudo) quando a IA conseguiu extrair — ver ai.service.js.
      if (session.veiculoInicial) {
        return _finalizarOrcamento(
          userId,
          { ...session, customerName: nomeSanitizado },
          session.veiculoInicial,
          session.pecaInicial || session.produtoInicial
        );
      }

      await updateSession(userId, {
        customerName: nomeSanitizado,
        step: "aguardando_veiculo",
      });
      return MSG.vendas.PEDIR_VEICULO;
    }

    // ── Etapa 2: Veículo ───────────────────────────────────────────────────────
    if (session.step === "aguardando_veiculo") {

      // Cliente corrigiu a peça em vez de responder o veículo — ver
      // _pareceCorrecaoDePeca acima. Atualiza a peça e repete a pergunta
      // de veículo, em vez de gravar a frase de correção como se fosse
      // o veículo (e manter a peça antiga errada).
      if (_pareceCorrecaoDePeca(message)) {
        const novaPeca = sanitizarTexto(message);
        await updateSession(userId, { pecaInicial: novaPeca, produtoInicial: novaPeca });
        logger.warn(`[vendasFlow] Correção de peça detectada na etapa veículo — userId=${userId} novaPeca="${novaPeca}"`);
        return "Entendido, ajustei aqui! 😊 " + MSG.vendas.PEDIR_VEICULO + MSG.ESCAPE_DICA;
      }

      const veiculo = msg === "pular" ? null : sanitizarTexto(message);
      const veiculoFinal = veiculo || "Não informado";

      // BUG CORRIGIDO: o cliente já tinha dito o que precisava na 1ª
      // mensagem (ex: "quero orçamento de uma palheta") — sem isso, o
      // fluxo perguntava "qual peça ou serviço você precisa?" de novo,
      // o cliente respondia "já falei" (frustrado) e ISSO virava a
      // descrição do orçamento. Se produtoInicial já é descritivo o
      // bastante, pula a etapa 3 e finaliza direto.
      //
      // BUG REAL (achado em teste ao vivo, 2026-07-20): esse check só olhava
      // pra session.produtoInicial — mas o caminho de confirmação de
      // orçamento (main.flow.js, intercept "aguardandoConfirmacaoOrcamento")
      // só grava session.pecaInicial, nunca produtoInicial. Resultado: um
      // cliente que pergunta "vocês trabalham com bomba de combustível?",
      // confirma com "sim" e informa o veículo, era perguntado "qual peça
      // você precisa?" de novo — a peça que ele JÁ tinha dito era ignorada.
      // Agora prefere pecaInicial (nome limpo da peça) e só cai pra
      // produtoInicial (frase crua) se pecaInicial não existir.
      const produtoOuPecaInicial = session.pecaInicial || session.produtoInicial || "";
      const produtoInicial = produtoOuPecaInicial ? sanitizarTexto(produtoOuPecaInicial) : "";
      const produtoValido  = validarTamanho(normalizar(produtoInicial), 5).ok;

      if (produtoValido) {
        return _finalizarOrcamento(userId, session, veiculoFinal, produtoInicial);
      }

      await updateSession(userId, {
        veiculo: veiculoFinal,
        step: "aguardando_orcamento",
      });
      return MSG.vendas.PEDIR_ORCAMENTO + MSG.ESCAPE_DICA;
    }

    // ── Etapa 3: Produto / descrição ───────────────────────────────────────────
    if (session.step === "aguardando_orcamento") {
      const v = validarTamanho(msg, 5);
      if (!v.ok) {
        return v.erro === "minimo"
          ? "⚠️ Por favor, descreva melhor o produto que precisa." + MSG.ESCAPE_DICA
          : mensagemTamanhoInvalido();
      }

      return _finalizarOrcamento(userId, session, session.veiculo, sanitizarTexto(message));
    }

    // ── Sub-menu de vendas ─────────────────────────────────────────────────────
    switch (msg) {
      case "1": {
        const nomeExistente = session.customerName;
        if (nomeExistente) {
          const primeiroNome = nomeExistente.trim().split(" ")[0];
          await updateSession(userId, { step: "aguardando_veiculo" });
          return `Certo, *${primeiroNome}*! ` + MSG.vendas.PEDIR_VEICULO + MSG.ESCAPE_DICA;
        }
        await updateSession(userId, { step: "aguardando_nome" });
        return MSG.vendas.PEDIR_NOME + MSG.ESCAPE_DICA;
      }

      default:
        return MSG.vendas.MENU();
    }
  }

  await updateSession(userId, { sector: "vendas" });
  return MSG.vendas.MENU();
}

module.exports = vendasFlow;
// Pedido do usuário: quando peça + veículo + nome já são conhecidos logo na
// 1ª mensagem, main.flow.js finaliza o orçamento direto, sem passar pelas
// perguntas deste fluxo — reaproveita a mesma lógica de criação de ticket
// (evita duplicar o formato da descrição/mensagens de sucesso e falha).
module.exports.finalizarOrcamento = _finalizarOrcamento;
