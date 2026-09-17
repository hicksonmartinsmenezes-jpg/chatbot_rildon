// Controles extras do player de áudio: velocidade e download.
(function bindAudioPlayerMenu() {
  const install = () => {
    const styleId = "rildon-audio-player-menu-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .rildon-audio-player {
          align-items: center !important;
          gap: 7px !important;
        }
        .rildon-audio-avatar {
          width: 42px !important;
          min-width: 42px !important;
          height: 42px !important;
          align-self: center !important;
        }
        .rildon-audio-avatar .chat-avatar,
        .rildon-audio-avatar .chat-avatar img,
        .rildon-audio-avatar .chat-avatar .avatar-fallback {
          width: 42px !important;
          height: 42px !important;
          min-width: 42px !important;
          min-height: 42px !important;
          border-radius: 50% !important;
        }
        .rildon-audio-avatar .chat-avatar {
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          overflow: hidden !important;
        }
        .rildon-audio-play {
          align-self: center !important;
          justify-content: center !important;
          align-items: center !important;
          line-height: 1 !important;
          text-align: center !important;
          flex: 0 0 36px !important;
        }
        .rildon-audio-play i {
          display: block !important;
          width: 17px !important;
          height: 17px !important;
          line-height: 17px !important;
          text-align: center !important;
          margin: 0 !important;
          transform: translateX(1px) !important;
        }
        .rildon-audio-main {
          justify-content: center !important;
        }
        .rildon-audio-time {
          line-height: 11px !important;
          min-height: 11px;
        }
        .rildon-audio-menu-wrap {
          position: relative;
          flex: 0 0 28px;
          width: 28px;
          height: 42px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .rildon-audio-menu-btn {
          width: 28px !important;
          min-width: 28px !important;
          height: 36px !important;
          min-height: 36px !important;
          padding: 0 !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 50% !important;
          background: transparent !important;
          box-shadow: none !important;
          color: #8696a0 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          cursor: pointer !important;
        }
        .rildon-audio-menu-btn:hover,
        .rildon-audio-menu-btn[aria-expanded="true"] {
          background: rgba(255,255,255,.07) !important;
          color: #d1d7db !important;
        }
        .rildon-audio-menu-btn i {
          font-size: 15px !important;
          letter-spacing: 2px;
        }
        .rildon-audio-menu {
          position: absolute;
          right: 0;
          bottom: 39px;
          z-index: 100;
          min-width: 145px;
          padding: 5px;
          border-radius: 10px;
          background: #202c33;
          border: 1px solid rgba(255,255,255,.08);
          box-shadow: 0 8px 24px rgba(0,0,0,.28);
          display: none;
        }
        .rildon-audio-menu.is-open {
          display: block;
        }
        .rildon-audio-menu-title {
          padding: 6px 9px 4px;
          color: #8696a0;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: .04em;
        }
        .rildon-audio-menu-item {
          width: 100% !important;
          min-width: 0 !important;
          height: 32px !important;
          min-height: 32px !important;
          padding: 0 9px !important;
          margin: 0 !important;
          border: 0 !important;
          border-radius: 7px !important;
          background: transparent !important;
          box-shadow: none !important;
          color: #e9edef !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          gap: 10px;
          font-size: 12px !important;
          cursor: pointer !important;
          transform: none !important;
        }
        .rildon-audio-menu-item:hover {
          background: rgba(255,255,255,.08) !important;
        }
        .rildon-audio-menu-item .menu-check {
          color: #53bdeb;
          font-size: 11px;
        }
        body.light-theme .rildon-audio-menu {
          background: #fff;
          border-color: rgba(0,0,0,.08);
          box-shadow: 0 8px 24px rgba(0,0,0,.16);
        }
        body.light-theme .rildon-audio-menu-item {
          color: #263238 !important;
        }
        body.light-theme .rildon-audio-menu-title {
          color: #667781;
        }
        @media (max-width: 600px) {
          .rildon-audio-menu-wrap {
            flex-basis: 26px;
            width: 26px;
          }
          .rildon-audio-menu-btn {
            width: 26px !important;
            min-width: 26px !important;
          }
        }
      `;
      document.head.appendChild(style);
    }

    const closeMenus = (except = null) => {
      document.querySelectorAll(".rildon-audio-menu.is-open").forEach(menu => {
        if (menu !== except) {
          menu.classList.remove("is-open");
          menu.previousElementSibling?.setAttribute("aria-expanded", "false");
        }
      });
    };

    const bind = (root = document) => {
      root.querySelectorAll?.("[data-audio-player]").forEach(player => {
        if (player.dataset.menuBound === "true") return;
        const audio = player.querySelector("[data-audio-element]");
        const main = player.querySelector(".rildon-audio-main");
        if (!audio || !main) return;
        player.dataset.menuBound = "true";

        const wrap = document.createElement("div");
        wrap.className = "rildon-audio-menu-wrap";
        wrap.innerHTML = `
          <button type="button" class="rildon-audio-menu-btn" data-audio-menu-btn aria-expanded="false" aria-label="Mais opções do áudio" title="Mais opções">
            <i class="fa-solid fa-ellipsis-vertical"></i>
          </button>
          <div class="rildon-audio-menu" data-audio-menu role="menu">
            <div class="rildon-audio-menu-title">Velocidade</div>
            <button type="button" class="rildon-audio-menu-item" data-audio-speed="1" role="menuitem">1x <span class="menu-check"></span></button>
            <button type="button" class="rildon-audio-menu-item" data-audio-speed="1.5" role="menuitem">1,5x <span class="menu-check"></span></button>
            <button type="button" class="rildon-audio-menu-item" data-audio-speed="2" role="menuitem">2x <span class="menu-check"></span></button>
            <button type="button" class="rildon-audio-menu-item" data-audio-download role="menuitem">Baixar <i class="fa-solid fa-download"></i></button>
          </div>
        `;
        player.appendChild(wrap);

        const menuBtn = wrap.querySelector("[data-audio-menu-btn]");
        const menu = wrap.querySelector("[data-audio-menu]");
        const speedButtons = wrap.querySelectorAll("[data-audio-speed]");

        const refreshChecks = () => {
          const speed = Number(audio.playbackRate || 1);
          speedButtons.forEach(btn => {
            const check = btn.querySelector(".menu-check");
            if (check) check.innerHTML = Number(btn.dataset.audioSpeed) === speed
              ? '<i class="fa-solid fa-check"></i>'
              : "";
          });
        };

        menuBtn.addEventListener("click", event => {
          event.stopPropagation();
          const open = menu.classList.toggle("is-open");
          closeMenus(open ? menu : null);
          menuBtn.setAttribute("aria-expanded", String(open));
          if (open) refreshChecks();
        });

        speedButtons.forEach(btn => {
          btn.addEventListener("click", event => {
            event.stopPropagation();
            audio.playbackRate = Number(btn.dataset.audioSpeed) || 1;
            refreshChecks();
            menu.classList.remove("is-open");
            menuBtn.setAttribute("aria-expanded", "false");
          });
        });

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
      const observer = new MutationObserver(() => bind(messagesBox));
      observer.observe(messagesBox, { childList: true, subtree: true });
    }

    if (!document.body.dataset.audioMenuDocumentBound) {
      document.body.dataset.audioMenuDocumentBound = "true";
      document.addEventListener("click", () => closeMenus());
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
