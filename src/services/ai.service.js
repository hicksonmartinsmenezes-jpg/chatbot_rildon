const fs      = require("fs");
const path    = require("path");
const logger  = require("../utils/logger");
const EMPRESA = require("../config/empresa");

// ─── Configuração de provedores ────────────────────────────────────────────────
// Para trocar de provedor: altere AI_PROVIDER no .env para "groq" ou "gemini"
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
};

const PROVIDER_NAME = (process.env.AI_PROVIDER || "groq").toLowerCase();
const PROVIDER      = PROVIDERS[PROVIDER_NAME] || PROVIDERS.groq;

const MAX_HISTORICO   = 6;   // pares de mensagens mantidos no histórico
const REQUEST_TIMEOUT = 25000;
const MAX_TENTATIVAS  = 2;

// Temperature mais baixa = respostas mais consistentes e menos "criativas"
// Para atendimento ao cliente, 0.45 é o ideal: natural mas previsível
const TEMPERATURE = 0.45;
// Máximo de tokens por resposta — WhatsApp pede respostas curtas
const MAX_TOKENS  = 380;

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

    case ".xlsx":
    case ".xls": {
      const XLSX   = require("xlsx");
      const wb     = XLSX.readFile(filePath);
      const partes = [];
      for (const sheetName of wb.SheetNames) {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        if (!rows.length) continue;
        partes.push(`[Aba: ${sheetName}]`);
        for (const row of rows) {
          const linha = Object.entries(row)
            .filter(([, v]) => String(v).trim() !== "")
            .map(([k, v]) => `${k}: ${v}`)
            .join(" | ");
          if (linha) partes.push(linha);
        }
      }
      return partes.join("\n");
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
      intro: `Assistente da ${EMPRESA.nome} — peças elétricas automotivas, Aracaju/SE, 30+ anos.`,
      corpo: `
ESTILO: simpático, informal-profissional, respostas curtas (máx 3 linhas), emojis moderados (máx 2).
Só mencione endereço/horário se perguntado diretamente. Não ofereça informações que o cliente não pediu.

ATUAÇÃO: linha leve (carros e motos), pesada (MB, Volvo, Scania, VW Truck, Iveco) e agrícola.
PRODUTOS ELÉTRICOS: ${EMPRESA.produtos.slice(0, 10).join(", ")}.
TAMBÉM TRABALHAMOS COM: peças de mecânica geral (filtros ar/óleo/combustível, pastilhas, lonas de freio, suspensão, direção).
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
${trainingBlock}

RETORNE SEMPRE JSON EXATO:
{"resposta":"texto","intencao":"chat"}

intencao DEVE SER:
• "vendas"    → cliente quer comprar, verificar preço ou disponibilidade de peça específica: "preciso de X", "tem X para Y?", "quanto custa", "vocês trabalham com X?", "tem filtro/alternador/sensor para [carro]?"
• "crediario" → menciona crediário, financiamento ou parcelamento explicitamente
• "atendente" → pede EXPLICITAMENTE falar com humano/atendente/vendedor agora
• "gestao"    → reclamação, insatisfação forte, produto com defeito, ou pede gerente/responsável
• "chat"      → PADRÃO: saudações, dúvidas técnicas sem intenção de compra imediata, informações gerais sobre a loja`,
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

function _extrairTextoResposta(provedor, data) {
  if (provedor === "groq") {
    return data?.choices?.[0]?.message?.content;
  }
  return data?.candidates?.[0]?.content?.parts?.[0]?.text;
}

// ─── Intenções válidas ─────────────────────────────────────────────────────────
const INTENCOES_VALIDAS = new Set(["vendas", "crediario", "atendente", "gestao", "chat"]);

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

      if (!resposta) {
        logger.warn("[IA] JSON sem campo 'resposta'.");
        return null;
      }

      return { resposta, intencao };

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
