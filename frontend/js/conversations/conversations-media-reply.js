// Responder mídia recebida (igual WhatsApp).
// As bolhas de mídia são renderizadas sem messageId no DOM. Aqui usamos a
// mesma ordem do histórico carregado para recuperar o id correto e alimentar
// o replyToMessage(), fazendo a faixa de resposta aparecer no composer.
(function bindMediaReply() {
  const install = () => {
    const box = document.getElementById("chat-messages");
    if (!box || box.dataset.mediaReplyBound === "true") return;
    box.dataset.mediaReplyBound = "true";

    const getMediaHistory = () => {
      const history = Array.isArray(window.allHistory) ? window.allHistory : [];
      return history.filter((item) =>
        item && item.message && item.mediaPath && !item.response && item.messageId
      );
    };

    const addButtons = () => {
      const bubbles = Array.from(
        box.querySelectorAll(".bubble-row.client-row .bubble.client")
      );
      const mediaHistory = getMediaHistory();
      let mediaIndex = 0;

      bubbles.forEach((bubble) => {
        if (!bubble.querySelector("img")) return;
        if (bubble.querySelector(".bubble-media-reply-btn")) return;

        const historyItem = mediaHistory[mediaIndex++];
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
