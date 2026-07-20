const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");

// Pedido do usuário (2026-07-20): "verifique por que arquivos de mídia e
// áudio não aparecem no meu painel de atendimento". Resposta: decisão
// deliberada de uma correção anterior (task #116, comentário em
// config/whatsapp.js) — o bot nunca salvava o arquivo em disco, só o fato
// de ter chegado. Este módulo faz a parte de disco dessa feature nova:
// salva o buffer da mídia recebida do cliente e devolve o suficiente pra
// servir de volta pro painel depois (ver rota GET /api/history/media/:id).
//
// Fica FORA de src/uploads/ (a pasta pública, servida sem autenticação —
// ver app.js) de propósito: mídia de cliente é conversa privada, não uma
// foto de perfil ou banner de campanha. Só sai daqui através da rota
// autenticada.
const MEDIA_DIR = path.join(__dirname, "../media-recebida");

if (!fs.existsSync(MEDIA_DIR)) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// Mapa pequeno e explícito em vez de uma lib de mime-types — só precisa
// cobrir os tipos que o WhatsApp realmente manda pra esses 4 grupos
// (imagem/áudio/vídeo/sticker); documento usa o nome original do cliente
// quando disponível, então não depende deste mapa pra extensão.
const EXTENSOES_POR_MIMETYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

function _extensaoPorMimetype(mimetype = "") {
  const base = mimetype.split(";")[0].trim().toLowerCase();
  if (EXTENSOES_POR_MIMETYPE[base]) return EXTENSOES_POR_MIMETYPE[base];
  // Fallback genérico: pega a parte depois da barra (ex: "audio/ogg" → "ogg"),
  // sanitizado — nunca usa o valor do mimetype sem filtrar pra montar um
  // nome de arquivo (poderia vir de um cliente malicioso via metadata).
  const generico = base.split("/")[1] || "bin";
  return generico.replace(/[^a-z0-9]/g, "").slice(0, 10) || "bin";
}

// messageId do WhatsApp normalmente é alfanumérico (ex: "3EB0C767D26..."),
// mas nunca confiamos nisso pra montar um caminho de arquivo sem sanitizar
// primeiro — mensagem forjada/adulterada não deve conseguir escrever fora
// de MEDIA_DIR (path traversal).
function _sanitizarParaNomeArquivo(valor) {
  return String(valor || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "sem-id";
}

// Salva o buffer da mídia recebida em disco e devolve o suficiente pra
// guardar em history.media_path/media_mimetype/media_filename. Nunca lança
// — falha de disco não pode derrubar o processamento da mensagem em si,
// só significa que essa mensagem específica fica sem mídia visível no
// painel (mesmo comportamento de "falha isolada" já usado em
// analisarFotoRecebida/analisarAudioRecebido).
async function salvarMidiaRecebida(buffer, mimetype, messageId, { originalFilename } = {}) {
  if (!buffer || !buffer.length) return null;

  try {
    const ext      = _extensaoPorMimetype(mimetype);
    const idSeguro = _sanitizarParaNomeArquivo(messageId);
    const sufixo   = crypto.randomBytes(4).toString("hex");
    const filename = `${idSeguro}-${sufixo}.${ext}`;
    const filePath = path.join(MEDIA_DIR, filename);

    await fs.promises.writeFile(filePath, buffer);

    return {
      mediaPath:     filename, // só o nome — nunca o caminho completo do disco
      mediaMimetype: mimetype || "application/octet-stream",
      mediaFilename: originalFilename || null,
    };
  } catch (err) {
    logger.warn(`[MediaStorage] Falha ao salvar mídia recebida (messageId=${messageId}): ${err.message}`);
    return null;
  }
}

// Resolve um media_path (só o nome do arquivo) pro caminho absoluto real em
// disco, com a mesma proteção contra path traversal já usada no handler
// público de /uploads/* em app.js. Devolve null se o resultado não estiver
// de fato dentro de MEDIA_DIR.
function resolverCaminhoMidia(mediaPath) {
  if (!mediaPath) return null;
  const filePath = path.resolve(MEDIA_DIR, mediaPath);
  if (filePath !== MEDIA_DIR && !filePath.startsWith(MEDIA_DIR + path.sep)) return null;
  return filePath;
}

module.exports = {
  MEDIA_DIR,
  salvarMidiaRecebida,
  resolverCaminhoMidia,
};
