/**
 * espelho.service.js — avisa o OUTRO processo do servidor quando algo muda.
 *
 * O catálogo da loja roda num contêiner próprio (src/catalogo-server.js), separado do painel
 * de atendimento (src/server.js). Os dois leem as mesmas pastas e o mesmo banco, mas mantêm
 * caches em memória (índice de fotos, preferências, estoque, índice de produtos). Quando um
 * deles muda algo, avisa o outro por POST /api/interno/recarregar para o cache não ficar velho.
 * Falha de rede é ignorada: o outro processo pode estar desligado, e o cache dele se
 * atualiza sozinho de qualquer forma no próximo ciclo (estoque, a cada 30 min) ou reinício.
 */
const logger = require("../utils/logger");

function ehProcessoCatalogo() {
  return process.env.CATALOGO_PROCESSO === "catalogo";
}

// Endereço do outro processo (nome do serviço na rede do Docker). Pode ser trocado por ESPELHO_URL.
function urlDoOutro() {
  if (process.env.ESPELHO_URL) return String(process.env.ESPELHO_URL).replace(/\/+$/, "");
  return ehProcessoCatalogo() ? "http://app:3000" : "http://catalogo:3001";
}

function segredo() {
  return process.env.INTERNO_TOKEN || process.env.API_TOKEN || "";
}

// tipo: "fotos" | "produtos" | "estoque". Nunca lança e nunca atrasa quem chamou.
function avisar(tipo) {
  if (process.env.ESPELHO_DESLIGADO === "1" || process.env.NODE_ENV === "test") return;
  const token = segredo();
  if (!token) return;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  if (t.unref) t.unref();
  fetch(urlDoOutro() + "/api/interno/recarregar", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Interno-Token": token },
    body: JSON.stringify({ tipo }),
    signal: ctl.signal
  }).catch((e) => {
    logger.debug?.(`[espelho] sem resposta do outro processo (${tipo}): ${e.message}`);
  }).finally(() => clearTimeout(t));
}

module.exports = { avisar, ehProcessoCatalogo, urlDoOutro };
