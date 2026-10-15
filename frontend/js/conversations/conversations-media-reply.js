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
            <div class="rildon-audio-track" data-audio-track>
              <div class="rildon-audio-wave" aria-hidden="true"></div>
              <div class="rildon-audio-wave rildon-audio-wave-played" data-audio-wave-played aria-hidden="true"></div>
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

    // Waveform falso (barras de altura fixa, não é a amplitude real do áudio —
    // decodificar o áudio pra amplitude de verdade seria custoso demais pra esse
    // painel). Mesmo assim já deixa MUITO mais parecido com o WhatsApp do que a
    // barrinha de progresso lisa (input range) que tinha antes. Gerado por JS pra
    // poder usar encodeURIComponent em vez de escapar `<`/`>`/`#` na mão no CSS.
    const buildWaveformDataUrl = (fill, opacity) => {
      const bars = [
        [2, 6, 8], [7, 3, 14], [12, 7, 6], [17, 2, 16],
        [22, 5, 10], [27, 3, 14], [32, 7, 6], [37, 4, 12]
      ];
      const rects = bars
        .map(([x, y, h]) => `<rect x="${x}" y="${y}" width="2" height="${h}" rx="1" fill="${fill}" fill-opacity="${opacity}"/>`)
        .join("");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="20">${rects}</svg>`;
      return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    };
    const waveUnplayedDark  = buildWaveformDataUrl("#ffffff", 0.22);
    const waveUnplayedLight = buildWaveformDataUrl("#000000", 0.18);
    const wavePlayedColor   = buildWaveformDataUrl("#1fdf9c", 1);

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
        /* Sem borda/sombra aqui de propósito: .chat-avatar (06-conversations.css)
           já vem com box-shadow+border pensados pra sidebar de conversas, mas no
           WhatsApp de verdade a foto dentro do balão de áudio é só o círculo liso,
           sem moldura nenhuma — por isso audio-player-menu.js (carrega depois)
           zera box-shadow/border especificamente aqui. */
        .rildon-audio-avatar {
          width: 36px;
          min-width: 36px;
          height: 36px;
          overflow: hidden;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .rildon-audio-avatar img,
        .rildon-audio-avatar .chat-avatar,
        .rildon-audio-avatar .avatar {
          width: 36px !important;
          height: 36px !important;
          min-width: 36px !important;
          min-height: 36px !important;
          border-radius: 50% !important;
          object-fit: cover;
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
          position: relative;
          width: 100%;
          height: 20px;
          display: flex;
          align-items: center;
        }
        .rildon-audio-wave {
          position: absolute;
          inset: 0;
          background-image: url("${waveUnplayedDark}");
          background-repeat: repeat-x;
          background-position: left center;
          background-size: 44px 20px;
          pointer-events: none;
        }
        body.light-theme .rildon-audio-wave {
          background-image: url("${waveUnplayedLight}");
        }
        .rildon-audio-wave-played {
          width: 0%;
          overflow: hidden;
          background-image: url("${wavePlayedColor}");
          background-repeat: repeat-x;
          background-position: left center;
          background-size: 44px 20px;
          transition: width .08s linear;
        }
        .rildon-audio-progress {
          position: relative;
          z-index: 2;
          width: 100%;
          height: 20px;
          margin: 0;
          padding: 0;
          background: transparent;
          cursor: pointer;
          -webkit-appearance: none;
          appearance: none;
        }
        .rildon-audio-progress::-webkit-slider-runnable-track {
          background: transparent;
          height: 20px;
        }
        .rildon-audio-progress::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #1fdf9c;
          box-shadow: 0 0 0 3px rgba(31,223,156,.18);
          margin-top: 0;
          cursor: pointer;
          opacity: 0;
          transition: opacity .12s ease;
        }
        .rildon-audio-progress::-moz-range-track {
          background: transparent;
          height: 20px;
          border: 0;
        }
        .rildon-audio-progress::-moz-range-thumb {
          width: 10px;
          height: 10px;
          border: 0;
          border-radius: 50%;
          background: #1fdf9c;
          box-shadow: 0 0 0 3px rgba(31,223,156,.18);
          cursor: pointer;
          opacity: 0;
          transition: opacity .12s ease;
        }
        .rildon-audio-player:hover .rildon-audio-progress::-webkit-slider-thumb,
        .rildon-audio-progress:focus-visible::-webkit-slider-thumb,
        .rildon-audio-player:hover .rildon-audio-progress::-moz-range-thumb,
        .rildon-audio-progress:focus-visible::-moz-range-thumb {
          opacity: 1;
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
        const wavePlayed = player.querySelector("[data-audio-wave-played]");
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
          const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
          progress.value = String(pct);
          if (wavePlayed) wavePlayed.style.width = `${pct}%`;
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
          if (wavePlayed) wavePlayed.style.width = "0%";
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
