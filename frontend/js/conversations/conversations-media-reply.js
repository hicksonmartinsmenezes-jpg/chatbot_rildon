// Responder mídia recebida (igual WhatsApp).
// O renderer principal só oferece reply para texto; aqui adicionamos a mesma
// ação às bolhas de foto sem alterar o fluxo de envio já existente.
(function bindMediaReply() {
  const install = () => {
    const box = document.getElementById("chat-messages");
    if (!box || box.dataset.mediaReplyBound === "true") return;
    box.dataset.mediaReplyBound = "true";

    const addButtons = () => {
      box.querySelectorAll(".bubble-row.client-row .bubble.client").forEach((bubble) => {
        if (bubble.querySelector(".bubble-reply-btn")) return;
        if (!bubble.querySelector("img")) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "bubble-reply-btn bubble-media-reply-btn";
        button.title = "Responder foto";
        button.setAttribute("aria-label", "Responder foto");
        button.innerHTML = '<i class="fa-solid fa-reply"></i>';

        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const msgId = bubble.dataset.msgId || bubble.closest(".bubble-row")?.dataset.msgId || "";
          if (!msgId || typeof replyToMessage !== "function") return;
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
