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

    const renderMediaBubbleWithReply = function(item) {
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

    // Atualiza tanto a propriedade global quanto a referência usada pelo
    // escopo global dos scripts clássicos do painel.
    window.renderMediaBubble = renderMediaBubbleWithReply;
    renderMediaBubble = renderMediaBubbleWithReply;

    // Foto recebida sem legenda: deixa a bolha compacta e coloca o horário
    // sobre a própria foto, como no WhatsApp. Fotos com legenda permanecem
    // no layout normal.
    const styleId = "rildon-photo-only-bubble-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .bubble-row.client-row .bubble.client.photo-only-media-bubble {
          position: relative;
          width: fit-content;
          max-width: min(75%, 420px);
          padding: 0 !important;
          background: transparent !important;
          border: 0 !important;
          box-shadow: none !important;
          overflow: visible;
        }
        .bubble-row.client-row .bubble.client.photo-only-media-bubble img {
          display: block;
          max-width: 100%;
          height: auto;
          border-radius: 12px;
        }
        .bubble-row.client-row .bubble.client.photo-only-media-bubble > small {
          position: absolute;
          right: 7px;
          bottom: 7px;
          z-index: 8;
          margin: 0 !important;
          padding: 3px 6px !important;
          border-radius: 8px;
          background: rgba(0, 0, 0, .52) !important;
          color: #fff !important;
          font-size: 10px !important;
          font-weight: 500;
          line-height: 1 !important;
          text-shadow: 0 1px 2px rgba(0,0,0,.35);
          pointer-events: none;
        }
        .bubble-row.client-row .bubble.client.photo-only-media-bubble .bubble-media-reply-btn {
          z-index: 10;
        }
      `;
      document.head.appendChild(style);
    }

    const markPhotoOnlyBubbles = () => {
      document.querySelectorAll(".bubble-row.client-row .bubble.client").forEach(bubble => {
        if (bubble.classList.contains("photo-only-media-bubble")) return;

        const image = bubble.querySelector("img");
        if (!image) return;

        // O renderer já não imprime <p> quando a mensagem é apenas o
        // placeholder da mídia. Se existir texto/caption real, não compacta.
        const hasCaption = Array.from(bubble.querySelectorAll("p"))
          .some(p => p.textContent.trim().length > 0);
        if (hasCaption) return;

        bubble.classList.add("photo-only-media-bubble");
      });
    };

    markPhotoOnlyBubbles();

    const messagesBox = document.getElementById("chat-messages");
    if (messagesBox) {
      const observer = new MutationObserver(markPhotoOnlyBubbles);
      observer.observe(messagesBox, { childList: true, subtree: true });
    }

    // ─── Composer: comportamento mais próximo do WhatsApp ────────────────
    // O Enviar só aparece quando existe texto ou algum arquivo selecionado.
    // A atualização fica aqui porque o arquivo já controla pendingMediaFile.
    const updateSendButtonVisibility = () => {
      const sendBtn = document.getElementById("btn-send-conversation");
      const input = document.getElementById("conversation-message");
      if (!sendBtn) return;

      const hasText = Boolean(input?.value?.trim());
      const hasMedia = Boolean(pendingMediaFile);
      sendBtn.classList.toggle("composer-send-hidden", !hasText && !hasMedia);
    };

    window.updateConversationSendButton = updateSendButtonVisibility;

    const input = document.getElementById("conversation-message");
    if (input && input.dataset.sendVisibilityBound !== "true") {
      input.dataset.sendVisibilityBound = "true";
      ["input", "change", "keyup"].forEach(eventName => {
        input.addEventListener(eventName, updateSendButtonVisibility);
      });
    }

    const mediaPreviewBar = document.getElementById("media-preview-bar");
    if (mediaPreviewBar) {
      const mediaObserver = new MutationObserver(updateSendButtonVisibility);
      mediaObserver.observe(mediaPreviewBar, {
        attributes: true,
        attributeFilter: ["class"]
      });
    }

    updateSendButtonVisibility();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
