const logger = require("../utils/logger");

// BUG CORRIGIDO (relatado pelo usuário — item #4 da análise de conversas em
// produção): o WhatsApp entrega cada "balão" que o cliente manda como uma
// mensagem separada, e o bot processava cada uma IMEDIATAMENTE — inclusive
// respondendo (às vezes avançando um passo do fluxo, às vezes já criando
// ticket) antes do cliente terminar de digitar o pensamento completo em
// várias mensagens curtas seguidas (comum no WhatsApp: "Preciso de um
// orçamento" / "Alternador" / "Corsa 2010 1.0"). O primeiro fragmento virava
// a resposta "completa" pro passo atual da sessão, e os fragmentos
// seguintes chegavam como mensagens novas, já fora de contexto.
//
// scheduleFragment() junta fragmentos de TEXTO puro (sem mídia — ver uso em
// config/whatsapp.js) do MESMO cliente que chegam dentro de uma janela
// curta (MESSAGE_FRAGMENT_WAIT_MS, padrão 2500ms): a cada fragmento novo,
// reinicia a espera; só processa de fato (uma linha por fragmento, um único
// messageId — o do último fragmento) quando a janela passa sem mensagem
// nova. Mensagens isoladas (a maioria) só ganham essa latência extra fixa
// antes da resposta — trade-off aceito para não quebrar fluxos de
// múltiplas etapas.
const FRAGMENT_WAIT_MS = Number(process.env.MESSAGE_FRAGMENT_WAIT_MS || 2500);

const _pending = new Map(); // userId -> { parts: string[], messageId, timer }

function scheduleFragment(userId, { text, messageId }, processar) {
  const atual = _pending.get(userId);

  if (atual) {
    clearTimeout(atual.timer);
    atual.parts.push(text);
    atual.messageId = messageId;
  }

  const entry = atual || { parts: [text], messageId };

  entry.timer = setTimeout(() => {
    _pending.delete(userId);
    const textoFinal = entry.parts.join("\n");
    if (entry.parts.length > 1) {
      logger.info(`[FRAGMENT] ${userId}: ${entry.parts.length} mensagens agrupadas em uma só`);
    }
    Promise.resolve(processar({ text: textoFinal, messageId: entry.messageId })).catch(err => {
      logger.error(`[FRAGMENT] Erro ao processar mensagem agrupada de ${userId}: ${err.message}`);
    });
  }, FRAGMENT_WAIT_MS);
  entry.timer.unref?.(); // não deve impedir o processo de encerrar (graceful shutdown/testes)

  _pending.set(userId, entry);
}

// Cancela fragmentos pendentes sem processar — usado em testes e em casos
// onde a sessão do usuário é encerrada/limpa antes da janela fechar.
function clearPending(userId) {
  const atual = _pending.get(userId);
  if (atual) {
    clearTimeout(atual.timer);
    _pending.delete(userId);
  }
}

function temPendente(userId) {
  return _pending.has(userId);
}

module.exports = { scheduleFragment, clearPending, temPendente, FRAGMENT_WAIT_MS };
