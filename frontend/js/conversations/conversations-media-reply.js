// Responder mídia recebida (igual WhatsApp).
// A mídia é renderizada pelo próprio renderMediaBubble(item), então o botão
// nasce junto com a bolha e recebe diretamente o messageId do mesmo registro.
// Isso elimina dependência de ordem do DOM, busca posterior no histórico ou
// correspondência por URL.
(function bindMediaReply() {
  const install = () => {
    if (typeof renderMediaBubble !== "function") return;
    if (window.__rildonMediaReplyInstalled) return;
    window.__rildonMediaReplyInstalled = true;

    const originalRenderMediaBubble = renderMediaBubble;

    window.renderMediaBubble = function renderMediaBubbleWithReply(item) {
      const mediaHtml = originalRenderMediaBubble(item);
      if (!mediaHtml) return mediaHtml;

      // Só mídia RECEBIDA do cliente. Mídia enviada pelo atendente possui
      // `response` e não deve ganhar o botão de responder.
      const ehMidiaCliente = Boolean(
        item?.mediaPath && item?.messageId && item?.message && !item?.response
      );
      if (!ehMidiaCliente) return mediaHtml;

      const ehPlaceholder = typeof isMediaPlaceholderLabel === "function"
        ? isMediaPlaceholderLabel(item.message)
        : false;
      const textoResposta = ehPlaceholder ? "📷 Foto" : item.message.slice(0, 300);

      const replyBtn = `<button type="button" class="bubble-reply-btn bubble-media-reply-btn" data-reply-msg-id="${escapeAttr(item.messageId)}" data-reply-text="${escapeAttr(textoResposta)}" title="Responder foto" aria-label="Responder foto"><i class="fa-solid fa-reply"></i></button>`;

      return `${replyBtn}${mediaHtml}`;
    };
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
