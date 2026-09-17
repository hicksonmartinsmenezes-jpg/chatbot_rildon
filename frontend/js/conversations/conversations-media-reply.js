// Responder mídia recebida e ajustes visuais de mídia.
// Mantém a lógica de resposta específica e aproxima o player de áudio do WhatsApp.
(function bindMediaReply() {
  const install = () => {
    if (typeof renderMediaBubble !== "function") return;
    if (window.__rildonMediaReplyInstalled) return;
    window.__rildonMediaReplyInstalled = true;

    const originalRenderMediaBubble = renderMediaBubble;

    const renderWhatsAppAudio = (item, originalHtml) => {
      if (!item?.mediaPath || !item?.id || !(item.mediaMimetype || "").startsWith("audio/")) {
        return originalHtml;
      }

      const url = `${BASE}/api/history/media/${item.id}`;
      const avatarName = item.pushName || item.name || item.contactName || "Cliente";
      const avatar = typeof avatarHtml === "function"
        ? avatarHtml(item.userId || "", avatarName)
        : "";

      return `
        <div class="rildon-audio-player" data-audio-player>
          <div class="rildon-audio-avatar">${avatar}</div>
          <button type="button" class="rildon-audio-play" data-audio-play title="Reproduzir" aria-label="Reproduzir áudio">
            <i class="fa-solid fa-play"></i>
          </button>
          <div class="rildon-audio-main">
            <div class="rildon-audio-track">
              <input class="rildon-audio-progress" data-audio-progress type="range" min="0" max="100" value="0" step="0.1" aria-label="Progresso do áudio">
            </div>
            <span class="rildon-audio-time" data-audio-time>0:00</span>
          </div>
          <audio class="rildon-audio-native" data-audio-element preload="none" src="${escapeAttr(url)}"></audio>
        </div>
      `;
    };

    const renderMediaBubbleWithReply = function(item) {
      const mediaHtml = originalRenderMediaBubble(item);
      if (!mediaHtml) return mediaHtml;

      const audioHtml = renderWhatsAppAudio(item, mediaHtml);
      if (audioHtml !== mediaHtml) return audioHtml;

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

    window.renderMediaBubble = renderMediaBubbleWithReply;
    renderMediaBubble = renderMediaBubbleWithReply;

    const styleId = "rildon-photo-audio-media-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        /* Foto recebida sem legenda: compacta, com horário sobre a imagem. */
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

        /* ─── Áudio: visual compacto inspirado no WhatsApp ─────────────── */
        .chat-messages .bubble:has(.rildon-audio-player) {
          width: min(350px, 100%) !important;
          max-width: 350px !important;
          min-width: 0 !important;
          padding: 7px 9px !important;
          border-radius: 18px !important;
        }
        .rildon-audio-player {
          position: relative;
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-width: 0;
          height: 50px;
          box-sizing: border-box;
        }
        .rildon-audio-avatar {
          width: 40px;
          min-width: 40px;
          height: 40px;
          overflow: hidden;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .rildon-audio-avatar img,
        .rildon-audio-avatar .avatar,
        .rildon-audio-avatar > div {
          width: 40px !important;
          height: 40px !important;
          min-width: 40px !important;
          min-height: 40px !important;
          border-radius: 50% !important;
        }
        .rildon-audio-play {
          width: 36px !important;
          min-width: 36px !important;
          max-width: 36px !important;
          height: 36px !important;
          min-height: 36px !important;
          max-height: 36px !important;
          padding: 0 !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 50% !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          background: transparent !important;
          box-shadow: none !important;
          color: #aebac1 !important;
          cursor: pointer !important;
          transform: none !important;
        }
        .rildon-audio-play:hover {
          background: rgba(255,255,255,.06) !important;
          color: #fff !important;
        }
        .rildon-audio-play i {
          font-size: 17px;
          pointer-events: none;
        }
        .rildon-audio-main {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 2px;
        }
        .rildon-audio-track {
          width: 100%;
          height: 16px;
          display: flex;
          align-items: center;
        }
        .rildon-audio-progress {
          width: 100%;
          height: 3px;
          margin: 0;
          padding: 0;
          accent-color: #8696a0;
          cursor: pointer;
        }
        .rildon-audio-time {
          display: block;
          font-size: 10px;
          line-height: 12px;
          color: #8696a0;
          font-variant-numeric: tabular-nums;
        }
        .rildon-audio-native {
          position: absolute !important;
          width: 1px !important;
          height: 1px !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .bubble-row.client-row .bubble.client .rildon-audio-player + small,
        .bubble-row.bot-row .bubble.bot .rildon-audio-player + p + small,
        .bubble-row.bot-row .bubble.bot .rildon-audio-player + small {
          margin-top: 1px !important;
        }
        @media (max-width: 600px) {
          .chat-messages .bubble:has(.rildon-audio-player) {
            width: min(88vw, 330px) !important;
            max-width: min(88vw, 330px) !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    // Inicializa play/pause, progresso e tempo. O player nativo fica oculto
    // para eliminar volume/mudo e deixar somente os controles úteis.
    const bindAudioPlayers = (root = document) => {
      root.querySelectorAll?.("[data-audio-player]").forEach(player => {
        if (player.dataset.audioBound === "true") return;
        const audio = player.querySelector("[data-audio-element]");
        const playBtn = player.querySelector("[data-audio-play]");
        const progress = player.querySelector("[data-audio-progress]");
        const time = player.querySelector("[data-audio-time]");
        if (!audio || !playBtn || !progress || !time) return;
        player.dataset.audioBound = "true";

        const formatTime = seconds => {
          const value = Math.max(0, Math.floor(Number(seconds) || 0));
          const min = Math.floor(value / 60);
          const sec = String(value % 60).padStart(2, "0");
          return `${min}:${sec}`;
        };

        const update = () => {
          time.textContent = formatTime(audio.currentTime);
          progress.value = audio.duration ? String((audio.currentTime / audio.duration) * 100) : "0";
        };
        const setIcon = () => {
          playBtn.innerHTML = audio.paused
            ? '<i class="fa-solid fa-play"></i>'
            : '<i class="fa-solid fa-pause"></i>';
          playBtn.title = audio.paused ? "Reproduzir" : "Pausar";
          playBtn.setAttribute("aria-label", audio.paused ? "Reproduzir áudio" : "Pausar áudio");
        };

        playBtn.addEventListener("click", async () => {
          try {
            if (audio.paused) {
              document.querySelectorAll("[data-audio-element]").forEach(other => {
                if (other !== audio) other.pause();
              });
              await audio.play();
            } else {
              audio.pause();
            }
          } catch (err) {
            console.warn("Não foi possível reproduzir o áudio:", err);
          }
          setIcon();
        });

        audio.addEventListener("loadedmetadata", update);
        audio.addEventListener("timeupdate", update);
        audio.addEventListener("play", setIcon);
        audio.addEventListener("pause", setIcon);
        audio.addEventListener("ended", () => {
          progress.value = "0";
          time.textContent = "0:00";
          setIcon();
        });

        progress.addEventListener("input", () => {
          if (!audio.duration) return;
          audio.currentTime = (Number(progress.value) / 100) * audio.duration;
          update();
        });

        update();
        setIcon();
      });
    };

    const markPhotoOnlyBubbles = () => {
      document.querySelectorAll(".bubble-row.client-row .bubble.client").forEach(bubble => {
        if (bubble.classList.contains("photo-only-media-bubble")) return;
        const image = bubble.querySelector("img");
        if (!image) return;
        const hasCaption = Array.from(bubble.querySelectorAll("p"))
          .some(p => p.textContent.trim().length > 0);
        if (hasCaption) return;
        bubble.classList.add("photo-only-media-bubble");
      });
      bindAudioPlayers(document.getElementById("chat-messages") || document);
    };

    markPhotoOnlyBubbles();

    const messagesBox = document.getElementById("chat-messages");
    if (messagesBox) {
      const observer = new MutationObserver(markPhotoOnlyBubbles);
      observer.observe(messagesBox, { childList: true, subtree: true });
    }

    // Composer: Enviar só aparece quando existe texto ou arquivo selecionado.
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
