// Controles extras do player de áudio: velocidade e download.
(function bindAudioPlayerMenu() {
  const install = () => {
    const styleId = "rildon-audio-player-menu-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .rildon-audio-player { align-items: center !important; gap: 7px !important; }
        .rildon-audio-avatar { width: 36px !important; min-width: 36px !important; height: 36px !important; align-self: center !important; }
        .rildon-audio-avatar .chat-avatar,
        .rildon-audio-avatar .chat-avatar img,
        .rildon-audio-avatar .chat-avatar .avatar-fallback { width: 36px !important; height: 36px !important; min-width: 36px !important; min-height: 36px !important; border-radius: 50% !important; }
        .rildon-audio-avatar .chat-avatar { display: flex !important; align-items: center !important; justify-content: center !important; overflow: hidden !important; box-shadow: none !important; border: 0 !important; }
        .rildon-audio-play { align-self: center !important; justify-content: center !important; align-items: center !important; line-height: 1 !important; text-align: center !important; flex: 0 0 36px !important; }
        .rildon-audio-play i { display: block !important; width: 17px !important; height: 17px !important; line-height: 17px !important; text-align: center !important; margin: 0 !important; transform: translateX(1px) !important; }
        .rildon-audio-main { justify-content: center !important; }
        .rildon-audio-time { line-height: 11px !important; min-height: 11px; }
        .rildon-audio-menu-wrap { position: relative; flex: 0 0 30px; width: 30px; height: 42px; display: flex; align-items: center; justify-content: center; }
        .rildon-audio-menu-btn { width: 30px !important; min-width: 30px !important; height: 36px !important; min-height: 36px !important; padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 50% !important; background: transparent !important; box-shadow: none !important; color: #8696a0 !important; display: flex !important; align-items: center !important; justify-content: center !important; cursor: pointer !important; }
        .rildon-audio-menu-btn:hover, .rildon-audio-menu-btn[aria-expanded="true"] { background: rgba(255,255,255,.07) !important; color: #d1d7db !important; }
        .rildon-audio-menu-btn i { font-size: 15px !important; }

        /* Menu compacto, inspirado no menu contextual do WhatsApp. */
        .rildon-audio-menu {
          position: absolute;
          right: 0;
          bottom: 42px;
          z-index: 100;
          width: 190px;
          padding: 5px;
          border: 0;
          border-radius: 9px;
          background: #233138;
          box-shadow: 0 5px 18px rgba(0,0,0,.30);
          display: none;
          overflow: hidden;
        }
        .rildon-audio-menu.is-open { display: block; }

        .rildon-audio-menu-label {
          padding: 7px 9px 5px;
          color: #8696a0;
          font-size: 10px;
          font-weight: 600;
          text-transform: none;
          letter-spacing: 0;
        }

        .rildon-audio-speed-group {
          display: flex;
          gap: 0;
          background: transparent;
          border-radius: 0;
          padding: 0;
          margin: 0 0 3px;
        }

        .rildon-audio-speed-btn {
          flex: 1 1 0;
          width: auto !important;
          min-width: 0 !important;
          height: 31px !important;
          min-height: 31px !important;
          padding: 0 !important;
          margin: 0 1px !important;
          border: 0 !important;
          border-radius: 6px !important;
          background: transparent !important;
          box-shadow: none !important;
          color: #c9d1d5 !important;
          font-family: inherit;
          font-size: 12px !important;
          font-weight: 500 !important;
          cursor: pointer !important;
          transform: none !important;
          transition: background .12s ease, color .12s ease;
        }
        .rildon-audio-speed-btn:hover { background: rgba(255,255,255,.08) !important; color: #fff !important; }
        .rildon-audio-speed-btn.is-active { background: rgba(255,255,255,.10) !important; color: #fff !important; font-weight: 600 !important; }

        .rildon-audio-menu-divider {
          height: 1px;
          margin: 4px 5px;
          background: rgba(255,255,255,.10);
        }

        .rildon-audio-menu-item {
          width: 100% !important;
          min-width: 0 !important;
          height: 36px !important;
          min-height: 36px !important;
          padding: 0 9px !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 6px !important;
          background: transparent !important;
          box-shadow: none !important;
          color: #e9edef !important;
          display: flex !important;
          align-items: center !important;
          justify-content: flex-start !important;
          gap: 10px;
          font-size: 12.5px !important;
          font-weight: 400 !important;
          cursor: pointer !important;
          transform: none !important;
        }
        .rildon-audio-menu-item:hover { background: rgba(255,255,255,.08) !important; }
        .rildon-audio-menu-item i { width: 15px; text-align: center; color: #aebac1; font-size: 12px; }

        body.light-theme .rildon-audio-menu { background: #fff; box-shadow: 0 5px 18px rgba(0,0,0,.16); }
        body.light-theme .rildon-audio-menu-label { color: #667781; }
        body.light-theme .rildon-audio-speed-btn { color: #54656f !important; }
        body.light-theme .rildon-audio-speed-btn:hover,
        body.light-theme .rildon-audio-speed-btn.is-active { background: rgba(0,0,0,.06) !important; color: #263238 !important; }
        body.light-theme .rildon-audio-menu-divider { background: rgba(0,0,0,.08); }
        body.light-theme .rildon-audio-menu-item { color: #263238 !important; }
        body.light-theme .rildon-audio-menu-item i { color: #667781; }

        @media (max-width: 600px) {
          .rildon-audio-menu-wrap { flex-basis: 28px; width: 28px; }
          .rildon-audio-menu-btn { width: 28px !important; min-width: 28px !important; }
          .rildon-audio-menu { width: 180px; }
        }
      `;
      document.head.appendChild(style);
    }

    const closeMenus = (except = null) => {
      document.querySelectorAll(".rildon-audio-menu.is-open").forEach(menu => {
        if (menu !== except) { menu.classList.remove("is-open"); menu.previousElementSibling?.setAttribute("aria-expanded", "false"); }
      });
    };

    const bind = (root = document) => {
      root.querySelectorAll?.("[data-audio-player]").forEach(player => {
        if (player.dataset.menuBound === "true") return;
        const audio = player.querySelector("[data-audio-element]");
        if (!audio) return;
        player.dataset.menuBound = "true";

        const wrap = document.createElement("div");
        wrap.className = "rildon-audio-menu-wrap";
        wrap.innerHTML = `
          <button type="button" class="rildon-audio-menu-btn" data-audio-menu-btn aria-expanded="false" aria-haspopup="true" aria-label="Mais opções do áudio" title="Mais opções"><i class="fa-solid fa-ellipsis-vertical"></i></button>
          <div class="rildon-audio-menu" data-audio-menu role="menu">
            <div class="rildon-audio-menu-label">Velocidade de reprodução</div>
            <div class="rildon-audio-speed-group" role="group" aria-label="Velocidade de reprodução">
              <button type="button" class="rildon-audio-speed-btn" data-audio-speed="1" role="menuitemradio">1x</button>
              <button type="button" class="rildon-audio-speed-btn" data-audio-speed="1.5" role="menuitemradio">1,5x</button>
              <button type="button" class="rildon-audio-speed-btn" data-audio-speed="2" role="menuitemradio">2x</button>
            </div>
            <div class="rildon-audio-menu-divider"></div>
            <button type="button" class="rildon-audio-menu-item" data-audio-download role="menuitem"><i class="fa-solid fa-download"></i><span>Baixar áudio</span></button>
          </div>`;
        player.appendChild(wrap);

        const menuBtn = wrap.querySelector("[data-audio-menu-btn]");
        const menu = wrap.querySelector("[data-audio-menu]");
        const speedButtons = wrap.querySelectorAll("[data-audio-speed]");

        const refreshChecks = () => {
          const speed = Number(audio.playbackRate || 1);
          speedButtons.forEach(btn => {
            const active = Number(btn.dataset.audioSpeed) === speed;
            btn.classList.toggle("is-active", active);
            btn.setAttribute("aria-checked", String(active));
          });
        };

        menuBtn.addEventListener("click", event => {
          event.stopPropagation();
          const open = menu.classList.toggle("is-open");
          closeMenus(open ? menu : null);
          menuBtn.setAttribute("aria-expanded", String(open));
          if (open) refreshChecks();
        });

        speedButtons.forEach(btn => btn.addEventListener("click", event => {
          event.stopPropagation();
          audio.playbackRate = Number(btn.dataset.audioSpeed) || 1;
          refreshChecks();
          menu.classList.remove("is-open");
          menuBtn.setAttribute("aria-expanded", "false");
        }));

        wrap.querySelector("[data-audio-download]")?.addEventListener("click", event => {
          event.stopPropagation();
          const src = audio.currentSrc || audio.src;
          if (!src) return;
          const link = document.createElement("a");
          link.href = src;
          link.download = `audio-${Date.now()}`;
          link.target = "_blank";
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          link.remove();
          menu.classList.remove("is-open");
          menuBtn.setAttribute("aria-expanded", "false");
        });

        refreshChecks();
      });
    };

    bind(document);
    const messagesBox = document.getElementById("chat-messages");
    if (messagesBox && !messagesBox.dataset.audioMenuObserver) {
      messagesBox.dataset.audioMenuObserver = "true";
      new MutationObserver(() => bind(messagesBox)).observe(messagesBox, { childList: true, subtree: true });
    }
    if (!document.body.dataset.audioMenuDocumentBound) {
      document.body.dataset.audioMenuDocumentBound = "true";
      document.addEventListener("click", () => closeMenus());
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true }); else install();
})();
