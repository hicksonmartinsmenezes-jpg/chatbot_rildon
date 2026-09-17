// Responder mídia recebida (igual WhatsApp).
// A bolha de mídia usa o id do registro no src da imagem. Recuperamos o
// messageId real pelo registro correspondente no histórico e acionamos o
// mesmo replyToMessage() usado pelas mensagens de texto.
(function bindMediaReply() {
  const install = () => {
    const box = document.getElementById("chat-messages");
    if (!box || box.dataset.mediaReplyBound === "true") return;
    box.dataset.mediaReplyBound = "true";

    const getMediaHistory = () => {
      try {
        const history = typeof allHistory !== "undefined" && Array.isArray(allHistory)
          ? allHistory
          : [];
        return history.filter((item) =>
          item && item.mediaPath && item.messageId && !item.response
        );
      } catch (_) {
        return [];
      }
    };

    const findHistoryItemForBubble = (bubble, mediaHistory) => {
      const img = bubble.querySelector("img");
      const src = img?.getAttribute("src") || "";
      if (!src) return null;

      // renderMediaBubble() gera /api/history/media/:id. Usar esse id evita
      // depender da ordem dos elementos ou do formato de userId/JID.
      const match = src.match(/\/api\/history\/media\/(\d+)(?:[?#]|$)/);
      if (match) {
        const recordId = Number(match[1]);
        const exact = mediaHistory.find(item => Number(item.id) === recordId);
        if (exact) return exact;
      }

      // Fallback para URLs que tenham sido transformadas pelo navegador.
      const normalized = src.split("?")[0].replace(/\/$/, "");
      return mediaHistory.find(item =>
        normalized.endsWith(`/api/history/media/${item.id}`)
      ) || null;
    };

    const addButtons = () => {
      const mediaHistory = getMediaHistory();
      box.querySelectorAll(".bubble-row.client-row .bubble.client").forEach((bubble) => {
        if (!bubble.querySelector("img")) return;
        if (bubble.querySelector(".bubble-media-reply-btn")) return;

        const historyItem = findHistoryItemForBubble(bubble, mediaHistory);
        const msgId = historyItem?.messageId || "";
        if (!msgId) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "bubble-reply-btn bubble-media-reply-btn";
        button.title = "Responder foto";
        button.setAttribute("aria-label", "Responder foto");
        button.setAttribute("data-reply-msg-id", msgId);
        button.setAttribute("data-reply-text", "📷 Foto");
        button.innerHTML = '<i class="fa-solid fa-reply"></i>';

        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof replyToMessage !== "function") return;
          replyToMessage(msgId, "📷 Foto");
        });

        bubble.prepend(button);
      });
    };

    addButtons();
    new MutationObserver(addButtons).observe(box, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
