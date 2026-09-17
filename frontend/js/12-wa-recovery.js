// 12-wa-recovery.js
// Recuperação do QR Code do WhatsApp no painel.
// Complementa 12-socket.js sem alterar o fluxo de mensagens/socket existente.

(() => {
  const POLL_MS = 1500;
  const RECOVERY_TIMEOUT_MS = 45_000;
  let statusTimer = null;
  let recoveryTimer = null;

  function ensureRecoveryWidget() {
    if (document.getElementById("wa-recovery-widget")) return;

    const widget = document.createElement("aside");
    widget.id = "wa-recovery-widget";
    widget.className = "wa-recovery-widget hidden";
    widget.setAttribute("aria-live", "polite");
    widget.innerHTML = `
      <div class="wa-recovery-header">
        <div class="wa-recovery-icon"><i class="fa-brands fa-whatsapp"></i></div>
        <div>
          <strong>WhatsApp desconectado</strong>
          <span>Reconecte para continuar atendendo</span>
        </div>
        <button type="button" class="wa-recovery-close" id="wa-recovery-close" aria-label="Fechar aviso">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div class="wa-recovery-body">
        <div id="wa-recovery-qr-area" class="wa-recovery-qr-area hidden">
          <canvas id="wa-recovery-qr-canvas" width="220" height="220"></canvas>
          <p>Abra o WhatsApp no celular → <strong>Dispositivos conectados</strong> → <strong>Conectar dispositivo</strong></p>
          <small>O QR Code é atualizado automaticamente.</small>
        </div>

        <div id="wa-recovery-waiting" class="wa-recovery-waiting">
          <i class="fa-solid fa-arrows-rotate fa-spin"></i>
          <strong>Aguardando QR Code...</strong>
          <span>O sistema está tentando recuperar a conexão.</span>
        </div>
      </div>

      <div class="wa-recovery-footer">
        <button type="button" class="wa-recovery-action" id="wa-recovery-reconnect">
          <i class="fa-solid fa-plug"></i> Reconectar
        </button>
      </div>
    `;

    document.body.appendChild(widget);

    document.getElementById("wa-recovery-close")?.addEventListener("click", () => {
      widget.classList.add("hidden");
    });

    document.getElementById("wa-recovery-reconnect")?.addEventListener("click", () => {
      window.requestWaReconnect?.();
    });
  }

  function showRecoveryWidget() {
    ensureRecoveryWidget();
    document.getElementById("wa-recovery-widget")?.classList.remove("hidden");
  }

  function hideRecoveryWidget() {
    document.getElementById("wa-recovery-widget")?.classList.add("hidden");
  }

  function renderRecoveryQr(qr) {
    if (!qr) return;
    ensureRecoveryWidget();
    showRecoveryWidget();

    const canvas = document.getElementById("wa-recovery-qr-canvas");
    const area = document.getElementById("wa-recovery-qr-area");
    const waiting = document.getElementById("wa-recovery-waiting");
    if (!canvas || typeof QRCode === "undefined") return;

    QRCode.toCanvas(canvas, qr, { width: 220, margin: 2 }, (err) => {
      if (err) return;
      area?.classList.remove("hidden");
      waiting?.classList.add("hidden");
    });
  }

  async function refreshWaStatus() {
    try {
      const res = await apiFetch(`${BASE}/api/whatsapp/status`);
      if (!res?.ok) return false;

      const info = await res.json();
      if (info.connected) {
        updateWaStatusPanel("connected");
        hideRecoveryWidget();
        stopRecoveryPolling();
        return true;
      }

      if (info.qr) {
        updateWaStatusPanel("qr");
        renderWaQr(info.qr);
        renderRecoveryQr(info.qr);
        return true;
      }

      updateWaStatusPanel("disconnected");
      showRecoveryWidget();
      return true;
    } catch (_) {
      return false;
    }
  }

  function startWaStatusPolling() {
    if (statusTimer) return;

    refreshWaStatus();
    statusTimer = setInterval(() => {
      refreshWaStatus();
    }, POLL_MS);
  }

  function stopRecoveryPolling() {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }

  function waitForWaQr() {
    stopRecoveryPolling();

    const startedAt = Date.now();
    recoveryTimer = setInterval(async () => {
      const ok = await refreshWaStatus();

      if (Date.now() - startedAt >= RECOVERY_TIMEOUT_MS) {
        stopRecoveryPolling();
        if (ok) {
          showToast("⚠️ O QR Code ainda não foi disponibilizado. Tente gerar novamente.");
        }
      }
    }, POLL_MS);
  }

  function bindQrSocket() {
    if (typeof socket === "undefined" || !socket) return;

    socket.on("qr_code", ({ qr } = {}) => {
      if (!qr) return;
      updateWaStatusPanel("qr");
      renderWaQr(qr);
      renderRecoveryQr(qr);
      waitForWaQr();
    });

    socket.on("whatsapp_status", ({ status } = {}) => {
      if (status === "connected") {
        stopRecoveryPolling();
        hideRecoveryWidget();
        refreshWaStatus();
      } else if (status === "disconnected" || status === "logged_out") {
        showRecoveryWidget();
        refreshWaStatus();
      }
    });
  }

  window.requestWaReconnect = async function requestWaReconnectResilient() {
    let info = null;

    try {
      const statusRes = await apiFetch(`${BASE}/api/whatsapp/status`);
      if (statusRes?.ok) info = await statusRes.json();
    } catch (_) {}

    const isConnected = !!info?.connected;

    const doReconnect = async (clearSession = false) => {
      try {
        const res = await apiFetch(`${BASE}/api/whatsapp/reconnect`, {
          method: "POST",
          body: JSON.stringify({ clearSession })
        });

        if (!res?.ok) {
          const data = await res?.json().catch(() => ({}));
          showToast(`❌ ${data.error || "Não foi possível reconectar."}`);
          return;
        }

        showRecoveryWidget();
        showToast("🔄 Reconexão solicitada. Aguardando o QR Code...");
        updateWaStatusPanel("disconnected");
        waitForWaQr();
      } catch (err) {
        showToast(`❌ Erro ao reconectar WhatsApp: ${err.message}`);
      }
    };

    if (isConnected) {
      const message = "O WhatsApp está conectado. Gerar um novo QR Code vai desconectar a sessão atual e você precisará escanear novamente no celular. Deseja continuar?";
      if (typeof showConfirmModal === "function") {
        showConfirmModal({
          title: "Reconectar WhatsApp",
          message,
          confirmText: "Reconectar",
          cancelText: "Cancelar",
          danger: true,
          onConfirm: () => doReconnect(true)
        });
        return;
      }

      if (!confirm(message)) return;
      await doReconnect(true);
      return;
    }

    await doReconnect(false);
  };

  window.startWaQrRecovery = startWaStatusPolling;

  ensureRecoveryWidget();
  bindQrSocket();
  startWaStatusPolling();
})();
