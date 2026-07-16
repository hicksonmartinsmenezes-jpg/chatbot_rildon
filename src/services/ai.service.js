const fs      = require("fs");
const path    = require("path");
const logger  = require("../utils/logger");
const EMPRESA = require("../config/empresa");

// ─── Configuração de provedores ────────────────────────────────────────────────
// Para trocar de provedor: altere AI_PROVIDER no .env para "groq", "gemini" ou "anthropic"
const PROVIDERS = {
  groq: {
    url:   "https://api.groq.com/openai/v1/chat/completions",
    // llama-3.1-8b-instant free tier: 6000 TPM.
    // Com ~1600 tokens/req (prompt expandido + resposta), max ~3 req/min seguro.
    // intervalMs = 60000/3 = 20000ms (1 req a cada 20s com margem).
    model: "llama-3.1-8b-instant",
    intervalMs: 20000,
    getKey: () => process.env.GROQ_API_KEY,
  },
  gemini: {
    url:   "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    model: "gemini-2.5-flash",
    // 10 req/min free tier → 1 req a cada 6.5s com margem
    intervalMs: 6500,
    getKey: () => process.env.GEMINI_API_KEY,
  },
  // Pedido do usuário: melhor qualidade de resposta e de classificação de
  // intenção (vendas/suporte/crediário/etc) que os provedores free tier
  // acima. Claude Haiku 4.5 escolhido pelo equilíbrio custo x qualidade
  // pro volume de um bot de atendimento via WhatsApp — sem tier gratuito,
  // então intervalMs aqui é só uma margem de segurança contra rajada em
  // caso de bug de loop, não um limite de free tier a respeitar.
  anthropic: {
    url:   "https://api.anthropic.com/v1/messages",
    model: "claude-haiku-4-5-20251001",
    intervalMs: 1000,
    getKey: () => process.env.ANTHROPIC_API_KEY,
  },
};

const PROVIDER_NAME = (process.env.AI_PROVIDER || "groq").toLowerCase();
const PROVIDER      = PROVIDERS[PROVIDER_NAME] || PROVIDERS.groq;

const MAX_HISTORICO   = 6;   // pares de mensagens mantidos no histórico
const REQUEST_TIMEOUT = 25000;
const MAX_TENTATIVAS  = 2;

// 0.65 = natural e variado sem inventar informações — ideal para atendimento conversacional
const TEMPERATURE = 0.65;
// Máximo de tokens por resposta — 512 permite respostas completas sem truncar
const MAX_TOKENS  = 512;

// ─── Rate limiter por provedor ─────────────────────────────────────────────────
let _ultimaRequisicao = 0;
let _filaPromise      = Promise.resolve();

function _agendarRequisicao() {
  // .catch(() => {}) garante que a cadeia nunca fique em estado "rejected":
  // se uma req anterior falhar, a próxima ainda será agendada normalmente.
  _filaPromise = _filaPromise
    .then(() => {
      const espera = Math.max(0, _ultimaRequisicao + PROVIDER.intervalMs - Date.now());
      return new Promise(r => setTimeout(r, espera));
    })
    .catch(() => {});
  return _filaPromise;
}

// ─── Pasta de treinamento ──────────────────────────────────────────────────────
const TRAINING_DIR = path.resolve(__dirname, "../../training");
let _trainingCache = null;

async function _parseFile(filePath, ext) {
  switch (ext) {
    case ".txt":
    case ".md":
      return await fs.promises.readFile(filePath, "utf8");

    case ".json": {
      const raw = await fs.promises.readFile(filePath, "utf8");
      return JSON.stringify(JSON.parse(raw), null, 2);
    }

    case ".pdf": {
      const data = await require("pdf-parse")(fs.readFileSync(filePath));
      return data.text;
    }

    case ".docx": {
      const result = await require("mammoth").extractRawText({ path: filePath });
      return result.value;
    }

    default:
      return null;
  }
}

async function _loadTrainingFiles() {
  if (!fs.existsSync(TRAINING_DIR)) return "";

  // Apenas txt/md/json — PDFs e planilhas devem ser pré-processados em .txt
  // para evitar estouro de tokens no contexto do modelo
  const SUPPORTED = /\.(txt|md|json)$/i;
  const files = fs.readdirSync(TRAINING_DIR)
    .filter(f => SUPPORTED.test(f) && !f.startsWith("~$") && !f.startsWith("_"))
    .sort();

  if (!files.length) return "";

  const mtimes = new Map(files.map(f => [f, fs.statSync(path.join(TRAINING_DIR, f)).mtimeMs]));

  if (_trainingCache) {
    const stale =
      _trainingCache.mtimes.size !== mtimes.size ||
      [...mtimes.entries()].some(([f, t]) => _trainingCache.mtimes.get(f) !== t);
    if (!stale) return _trainingCache.content;
  }

  const parts = [];
  for (const file of files) {
    try {
      const text = await _parseFile(path.join(TRAINING_DIR, file), path.extname(file).toLowerCase());
      if (text?.trim()) {
        const label = file.replace(/\.[^.]+$/, "").replace(/[_-]/g, " ").toUpperCase();
        parts.push(`=== ${label} ===\n${text.trim()}`);
      }
    } catch (err) {
      logger.warn(`[IA] Erro ao ler "${file}": ${err.message}`);
    }
  }

  const content = parts.join("\n\n");
  _trainingCache = { content, mtimes };
  logger.info(`[IA] Treinamento: ${files.length} arquivo(s) | ${(content.length / 1024).toFixed(1)} KB | provedor: ${PROVIDER_NAME}`);
  return content;
}

// ─── Cache do system prompt (3 min TTL) ───────────────────────────────────────
// A base do prompt (training + identidade da empresa) é pesada e idêntica para
// todos os usuários — cacheada uma única vez.
// Nome do cliente e contexto (horário, status) são leves e injetados dinamicamente
// em cada chamada, sem invalidar o cache e sem risco de vazar dados entre usuários.
let _promptBaseCache   = null;   // texto base sem nome/contexto
let _promptBaseCacheAt = 0;
const PROMPT_TTL       = 3 * 60 * 1000;

async function _buildSystemPrompt(nomeCliente, contexto) {
  const agora = Date.now();

  // Reconstrói a base apenas quando o cache expira (TTL) — independente do usuário
  if (!_promptBaseCache || agora - _promptBaseCacheAt >= PROMPT_TTL) {
    const trainingRaw   = await _loadTrainingFiles();
    // Limita o bloco de treinamento a 5000 chars (~1250 tokens) para não estourar TPM.
    // Arquivos carregados em ordem alfabética — nomear com "00_" garante prioridade.
    // O restante do knowledge base está no prompt de identidade da empresa.
    const trainingTrimmed = trainingRaw.length > 5000
      ? trainingRaw.slice(0, 5000) + "\n[... conteúdo adicional disponível no sistema ...]"
      : trainingRaw;
    const trainingBlock   = trainingTrimmed
      ? `\n\n--- BASE DE CONHECIMENTO ---\n${trainingTrimmed}\n--- FIM ---`
      : "";

    _promptBaseCache = {
      intro: `Você é a Ril, assistente virtual da ${EMPRESA.nome} — peças elétricas automotivas em Aracaju/SE, mais de 30 anos no mercado.`,
      corpo: `
PERSONALIDADE: simpática, prestativa e experiente em autopeças. Converse de forma natural e calorosa, como um bom vendedor pelo WhatsApp. Adapte o tom: mais técnico com quem demonstra conhecimento, mais acolhedor com clientes comuns.

ESTILO:
• Respostas objetivas e completas — não corte informação importante por brevidade
• Emojis com moderação (máx 2 por mensagem)
• Varie o início das respostas — evite começar sempre da mesma forma
• Quando precisar de mais detalhes para ajudar, faça UMA pergunta objetiva
• Quando o cliente agradece ou se despede, responda de forma calorosa e breve

SAUDAÇÕES: Responda de volta de forma natural e calorosa. Se o cliente diz "bom dia", diga "Bom dia! 😊 Em que posso te ajudar?" — não liste opções em resposta a um cumprimento. Deixe a conversa fluir antes de mencionar opções de menu. IMPORTANTE: se a mensagem já vier com um pedido junto da saudação (ex: "Bom dia, tem motor de partida?"), comece MESMO ASSIM retribuindo a saudação antes de responder o pedido — nunca ignore o cumprimento pra ir direto na resposta técnica.

PRODUTOS: linha leve (carros e motos), pesada (MB, Volvo, Scania, VW Truck, Iveco) e agrícola.
ELÉTRICOS: ${EMPRESA.produtos.slice(0, 10).join(", ")}.
MECÂNICA GERAL: filtros ar/óleo/combustível, pastilhas, lonas de freio, suspensão, direção.
MARCAS: ${EMPRESA.marcas.join(", ")}.
NÃO TRABALHAMOS: elétrica residencial/industrial (tomadas NBR, disjuntores prediais, eletrodutos).

CONTATO: ${EMPRESA.telefone} | ${EMPRESA.endereco} | ${EMPRESA.horario.semana} | Sáb ${EMPRESA.horario.sabado}
PAGAMENTO: ${EMPRESA.pagamento.join(", ")}.
POLÍTICAS: troca=${EMPRESA.politica_troca}; entrega=${EMPRESA.prazo_entrega}; NF-e em todas compras.

INSTRUÇÕES:
${EMPRESA.instrucoes.map(i => `• ${i}`).join("\n")}

CONTEXTO DE HORÁRIO: use o CONTEXTO ATUAL para responder se a loja está aberta agora.
• Se fora do horário e cliente pergunta se pode ir → informe que está fechado e diga o próximo horário.
• Se fora do horário e cliente pede orçamento → confirme que pode solicitar agora e será respondido no próximo dia útil.

NUNCA: invente preços, disponibilidade de estoque ou prazos específicos que não constam acima. Não repita o nome do cliente a cada mensagem.
${trainingBlock}

RETORNE SEMPRE JSON EXATO:
{"resposta":"texto","intencao":"chat","veiculo":null,"peca":null,"pedidoExplicito":false}

"veiculo": preencha APENAS quando intencao for "vendas" E o veículo (marca, modelo e/ou ano) já tiver sido mencionado — na mensagem atual OU em mensagem anterior desta mesma conversa — ex: "Fiat Palio 2025", "uno 2015", "gol quadrado". Isso permite ao sistema pular a pergunta "qual o veículo?" quando já souber a resposta, evitando perguntar de novo algo que o cliente já disse. Se o veículo NÃO foi mencionado em nenhum momento, ou intencao for diferente de "vendas", retorne null. NUNCA invente ou presuma um veículo que o cliente não informou — na dúvida, null.

"peca": preencha APENAS quando intencao for "vendas" E a peça/produto pedido estiver claro — na mensagem atual ou em mensagem anterior desta conversa — com o nome LIMPO e objetivo da peça, ex: "Motor de partida", "Pastilha de freio dianteira", "Alternador". NUNCA inclua na "peca" saudações ("bom dia"), o veículo (isso já vai no campo "veiculo" acima) ou frases inteiras do cliente — só o nome da peça em si. Se não conseguir identificar uma peça específica com clareza, retorne null (o sistema usa a mensagem original nesse caso).

"pedidoExplicito": true APENAS quando o cliente claramente PEDE/SOLICITA o orçamento ou quer comprar — ex: "quero orçamento", "preciso de um orçamento", "quero comprar", "manda o valor", "pode fazer o orçamento", ou uma confirmação direta ("sim", "pode ser", "quero sim") logo depois de você ter perguntado se ele quer solicitar orçamento. false quando é APENAS uma pergunta/consulta, sem pedido de ação — ex: "tem X?", "vocês trabalham com X?", "vocês têm X pra Y?", "existe X aí?". Nesses casos de simples consulta, responda a pergunta normalmente e, se fizer sentido, pergunte se o cliente quer que você registre o orçamento — mas NÃO marque pedidoExplicito como true até ele confirmar. Na dúvida, false (o sistema só cria o ticket automaticamente quando pedidoExplicito é true — uma pergunta de disponibilidade nunca deve virar ticket sozinha).

intencao DEVE SER:
• "vendas"    → cliente quer comprar, verificar preço ou disponibilidade de peça: "preciso de X", "tem X para Y?", "quanto custa", "vocês trabalham com X?"
• "crediario" → menciona crediário, financiamento ou parcelamento explicitamente
• "atendente" → pede para falar com atendente, vendedor ou funcionário para tirar dúvida ou fazer compra: "falar com atendente", "quero falar com alguém", "tem vendedor?"
• "suporte"   → relata problema técnico com produto adquirido, defeito em peça comprada, dúvida de funcionamento de produto já instalado
• "gestao"    → quer falar com a equipe, time ou responsável de forma geral; reclamação sobre atendimento, insatisfação grave, pede falar com gerente: "falar com a equipe", "quero falar com a equipe", "fale com equipe", "falar com o responsável"
• "chat"      → PADRÃO: saudações, bate-papo, dúvidas técnicas sem intenção de compra imediata, informações gerais

IMPORTANTE sobre intenção "vendas": só quando "pedidoExplicito" for true o SISTEMA vai perguntar automaticamente (nesta ordem), logo depois da sua resposta, o nome do cliente, depois o veículo (pulado automaticamente se você já preencheu "veiculo" acima), depois a peça — nesse caso, sua "resposta" deve APENAS confirmar breve e calorosamente que vai ajudar com o orçamento, SEM perguntar modelo de veículo, chassi, ano ou qual peça precisa (perguntar isso faz o cliente responder a pergunta errada, pois a próxima pergunta do sistema pode ser sobre o nome dele, e os dados do orçamento saem trocados). Quando "pedidoExplicito" for false (o cliente só perguntou/consultou, sem pedir ação), responda normalmente e pode perguntar se ele quer que você registre o orçamento — o sistema NÃO vai criar nada sozinho nesse caso, então não há risco de pergunta cruzada.`,
    };
    _promptBaseCacheAt = agora;
  }

  // Cabeçalho dinâmico — nome do cliente e contexto de horário, gerado por chamada
  // Nunca armazenado em cache para não vazar entre usuários
  const cabecalho = [
    _promptBaseCache.intro,
    nomeCliente ? `\nVocê está conversando com ${nomeCliente}.` : "",
    `\nCONTEXTO ATUAL:
- Data/Hora: ${contexto.horarioAtual}
- Atendimento humano: ${contexto.atendimentoAberto ? "disponível agora" : "fora do horário (Seg-Sex 07:50-17:50 | Sáb 08:00-12:00)"}`,
  ].filter(Boolean).join("");

  return cabecalho + _promptBaseCache.corpo;
}


// ─── Extrai JSON da resposta ───────────────────────────────────────────────────
function _extrairJSON(texto) {
  try { return JSON.parse(texto); } catch {}
  const match = texto.match(/\{[\s\S]*?"resposta"[\s\S]*?\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  const m = texto.match(/"resposta"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) return { resposta: m[1], intencao: "chat" };
  return null;
}

// ─── Fetch com timeout ─────────────────────────────────────────────────────────
async function _fetchComTimeout(url, options, ms) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Adaptadores por provedor ──────────────────────────────────────────────────

async function _chamarGroq(systemPrompt, contents, apiKey) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...contents.map(c => ({
      role:    c.role === "model" ? "assistant" : "user",
      content: c.parts[0].text,
    })),
  ];

  const res = await _fetchComTimeout(
    PROVIDER.url,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:           PROVIDER.model,
        messages,
        temperature:     TEMPERATURE,
        max_tokens:      MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
    },
    REQUEST_TIMEOUT
  );

  return res;
}

async function _chamarGemini(systemPrompt, contents, apiKey) {
  const res = await _fetchComTimeout(
    `${PROVIDER.url}?key=${apiKey}`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature:      TEMPERATURE,
          maxOutputTokens:  MAX_TOKENS,
          topP:             0.92,
          responseMimeType: "application/json",
        },
      }),
    },
    REQUEST_TIMEOUT
  );

  return res;
}

// A API da Anthropic não tem um modo "json_object" nativo como a API
// OpenAI-compatible do Groq. Em vez de depender só do fallback de regex em
// _extrairJSON (usado pelos outros provedores), usamos a técnica de
// "prefill": a última mensagem é do papel "assistant" já começando com "{",
// o que força o modelo a continuar a partir dali — o texto retornado NÃO
// inclui esse prefixo (comportamento da API), então _extrairTextoResposta
// recompõe o "{" antes do parse. Isso praticamente elimina falha de
// parsing de JSON com este provedor.
async function _chamarAnthropic(systemPrompt, contents, apiKey) {
  const messages = [
    ...contents.map(c => ({
      role:    c.role === "model" ? "assistant" : "user",
      content: c.parts[0].text,
    })),
    { role: "assistant", content: "{" },
  ];

  const res = await _fetchComTimeout(
    PROVIDER.url,
    {
      method:  "POST",
      headers: {
        "content-type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       PROVIDER.model,
        system:      systemPrompt,
        messages,
        temperature: TEMPERATURE,
        max_tokens:  MAX_TOKENS,
      }),
    },
    REQUEST_TIMEOUT
  );

  return res;
}

function _extrairTextoResposta(provedor, data) {
  if (provedor === "groq") {
    return data?.choices?.[0]?.message?.content;
  }
  if (provedor === "anthropic") {
    const texto = data?.content?.[0]?.text;
    // Recompõe o "{" do prefill — ver nota em _chamarAnthropic.
    return texto ? `{${texto}` : texto;
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

// ─── Intenções válidas ─────────────────────────────────────────────────────────
const INTENCOES_VALIDAS = new Set(["vendas", "crediario", "atendente", "gestao", "suporte", "chat"]);

// ─── Função principal ──────────────────────────────────────────────────────────
async function perguntarIA(mensagem, { nomeCliente, historico = [], contexto = {} } = {}) {
  const apiKey = PROVIDER.getKey();
  if (!apiKey || apiKey === "cole_sua_chave_aqui") {
    logger.warn(`[IA] Chave do provedor "${PROVIDER_NAME}" não configurada no .env`);
    return null;
  }

  const tz = process.env.TZ_NEGOCIO || "America/Maceio";
  const contextoCompleto = {
    horarioAtual:      new Date().toLocaleString("pt-BR", { timeZone: tz }),
    atendimentoAberto: contexto.atendimentoAberto ?? false,
    ...contexto,
  };

  const historicoLimpo = historico
    .filter(h => h?.parts?.[0]?.text?.trim())
    .slice(-(MAX_HISTORICO * 2));

  const contents     = [...historicoLimpo, { role: "user", parts: [{ text: mensagem }] }];
  const systemPrompt = await _buildSystemPrompt(nomeCliente, contextoCompleto);

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      await _agendarRequisicao();
      _ultimaRequisicao = Date.now();

      const res = PROVIDER_NAME === "gemini"
        ? await _chamarGemini(systemPrompt, contents, apiKey)
        : PROVIDER_NAME === "anthropic"
        ? await _chamarAnthropic(systemPrompt, contents, apiKey)
        : await _chamarGroq(systemPrompt, contents, apiKey);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "60", 10);
        logger.warn(`[IA] Rate limit (429) — ${PROVIDER_NAME} — aguardando ${retryAfter}s`);
        if (tentativa < MAX_TENTATIVAS) await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if ([500, 502, 503, 504].includes(res.status)) {
        logger.warn(`[IA] HTTP ${res.status} — tentativa ${tentativa}/${MAX_TENTATIVAS}`);
        if (tentativa < MAX_TENTATIVAS) await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      if (!res.ok) {
        logger.warn(`[IA] Erro ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
        return null;
      }

      const data  = await res.json();
      const texto = _extrairTextoResposta(PROVIDER_NAME, data);

      if (!texto) {
        logger.warn("[IA] Resposta vazia do modelo.");
        return null;
      }

      const parsed   = _extrairJSON(texto);
      const resposta = parsed?.resposta?.trim();
      const intencao = INTENCOES_VALIDAS.has(parsed?.intencao) ? parsed.intencao : "chat";
      // Pedido do usuário: quando o cliente já menciona o veículo na 1ª
      // mensagem (ex: "motor de partida fiat palio 2025"), main.flow.js usa
      // este campo pra pular a pergunta redundante "qual o veículo?".
      // Qualquer valor que não seja string não-vazia vira null (não
      // identificado) — ver instrução no prompt em _buildSystemPrompt.
      const veiculo = typeof parsed?.veiculo === "string" && parsed.veiculo.trim()
        ? parsed.veiculo.trim()
        : null;
      // Mesma ideia do "veiculo" acima, mas pro nome da peça — evita que a
      // descrição do ticket vire a frase inteira do cliente (com saudação
      // e tudo mais) quando a IA já consegue extrair algo limpo.
      const peca = typeof parsed?.peca === "string" && parsed.peca.trim()
        ? parsed.peca.trim()
        : null;
      // Pedido do usuário (bug real: ticket #2026-0056 — cliente só
      // perguntou "tem motor de partida fiat palio?" e o sistema já
      // registrou o orçamento sem confirmação nenhuma). Só true quando o
      // cliente realmente PEDE o orçamento/compra — uma pergunta de
      // disponibilidade não deve disparar criação automática de ticket.
      const pedidoExplicito = parsed?.pedidoExplicito === true;

      if (!resposta) {
        logger.warn("[IA] JSON sem campo 'resposta'.");
        return null;
      }

      return { resposta, intencao, veiculo, peca, pedidoExplicito };

    } catch (err) {
      if (err.name === "AbortError") {
        logger.warn(`[IA] Timeout ${REQUEST_TIMEOUT / 1000}s — tentativa ${tentativa}`);
      } else {
        logger.error(`[IA] Erro tentativa ${tentativa}: ${err.message}`);
      }
      if (tentativa < MAX_TENTATIVAS) await new Promise(r => setTimeout(r, 3000));
    }
  }

  logger.error(`[IA] Todas as tentativas falharam (provedor: ${PROVIDER_NAME}).`);
  return null;
}

module.exports = { perguntarIA };
