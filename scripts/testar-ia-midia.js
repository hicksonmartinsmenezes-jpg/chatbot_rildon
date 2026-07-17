/**
 * Testa manualmente as features de IA de mídia (visão/foto e transcrição de
 * áudio) contra as APIs reais dos provedores configurados no .env — sem
 * precisar de uma sessão WhatsApp real.
 *
 * Por quê este script existe: o ambiente onde essas duas features foram
 * desenvolvidas não tem acesso de rede às APIs da Groq/Gemini/Anthropic (só
 * um allowlist restrito), então não dava pra confirmar o funcionamento de
 * ponta a ponta por lá — só com testes mockados. Rode este script no seu
 * ambiente real (local ou dentro do container, ambos com internet) pra
 * validar de verdade com um arquivo de foto ou áudio.
 *
 * Uso:
 *   node scripts/testar-ia-midia.js foto caminho/da/imagem.jpg
 *   node scripts/testar-ia-midia.js audio caminho/do/audio.ogg
 *
 * Exemplos:
 *   node scripts/testar-ia-midia.js foto ~/Desktop/motor-partida.jpg
 *   node scripts/testar-ia-midia.js audio ~/Desktop/nota-de-voz.ogg
 *
 * Via Docker (arquivo precisa estar acessível DENTRO do container primeiro):
 *   docker cp ./teste.jpg chatbot_rildon_app:/tmp/teste.jpg
 *   docker exec -it chatbot_rildon_app node scripts/testar-ia-midia.js foto /tmp/teste.jpg
 *
 * Notas:
 * - A análise de FOTO só roda de verdade se AI_PROVIDER no .env for "gemini"
 *   ou "anthropic" (Groq não suporta imagem) — o script avisa se não for.
 * - A transcrição de ÁUDIO é independente do AI_PROVIDER: só precisa de
 *   GROQ_API_KEY configurada (usa a API de Whisper da Groq direto).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const fs = require("fs");

const MIME_POR_EXTENSAO = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".webp": "image/webp",
  ".ogg":  "audio/ogg",
  ".oga":  "audio/ogg",
  ".mp3":  "audio/mpeg",
  ".m4a":  "audio/mp4",
  ".wav":  "audio/wav",
};

function mimeTypeDoArquivo(filePath) {
  return MIME_POR_EXTENSAO[path.extname(filePath).toLowerCase()] || null;
}

async function main() {
  const [, , tipo, filePath] = process.argv;

  if (!["foto", "audio"].includes(tipo) || !filePath) {
    console.error("Uso: node scripts/testar-ia-midia.js <foto|audio> <caminho-do-arquivo>");
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`Arquivo não encontrado: ${filePath}`);
    process.exit(1);
  }

  const mimeType = mimeTypeDoArquivo(filePath);
  if (!mimeType) {
    console.error(
      `Extensão não reconhecida: "${path.extname(filePath)}". ` +
      `Use jpg/png/webp para foto, ou ogg/mp3/m4a/wav para áudio.`
    );
    process.exit(1);
  }

  const { analisarImagemPeca, suportaVisao, transcreverAudio, suportaAudio } = require("../src/services/ai.service");

  console.log(`Provedor de chat ativo (AI_PROVIDER): ${process.env.AI_PROVIDER || "groq (padrão)"}`);

  const buffer = fs.readFileSync(filePath);
  console.log(`Arquivo: ${filePath} (${mimeType}, ${(buffer.length / 1024).toFixed(1)} KB)\n`);

  if (tipo === "foto") {
    console.log(`suportaVisao(): ${suportaVisao()}`);
    if (!suportaVisao()) {
      console.log(
        "Provedor de chat ativo não suporta imagem (só gemini/anthropic). " +
        "Troque AI_PROVIDER no .env pra testar de verdade — rodando assim mesmo só confirma o no-op silencioso."
      );
    }

    console.log("Analisando imagem...");
    const descricao = await analisarImagemPeca(buffer.toString("base64"), mimeType);

    console.log("\n--- Resultado ---");
    console.log(descricao === null
      ? "null (não reconheceu como peça/veículo, chave ausente, ou falha — ver avisos [IA-Visão] acima)"
      : descricao);
  }

  if (tipo === "audio") {
    console.log(`suportaAudio(): ${suportaAudio()} (independe do AI_PROVIDER — só precisa de GROQ_API_KEY)`);

    console.log("Transcrevendo áudio...");
    const transcricao = await transcreverAudio(buffer, mimeType);

    console.log("\n--- Resultado ---");
    console.log(transcricao === null
      ? "null (sem GROQ_API_KEY, erro na API, ou nenhuma fala reconhecível — ver avisos [IA-Áudio] acima)"
      : transcricao);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Falha ao testar mídia:", err.message);
  process.exit(1);
});
