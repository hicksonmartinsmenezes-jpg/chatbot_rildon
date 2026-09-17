// 12-wa-recovery.js
// Recuperação do QR Code do WhatsApp no painel.
// Complementa 12-socket.js sem alterar o fluxo de mensagens/socket existente.

(() => {
  const POLL_MS = 1500;
  const RECOVERY_TIMEOUT_MS = 45_000;
  let statusTimer = null;
  let recoveryTimer = null;

  async function refreshWaStatus() {
    try {
      const res = await apiFetch(`${BASE}/api/whatsapp/status`);
      if (!res?.ok) return false;

      const info = await res.json();
      if (info.connected) {
        updateWaStatusPanel("connected");
        return true;
      }

      if (info.qr) {
        updateWaStatusPanel("qr");
        renderWaQr(info.qr);
        return true;
      }

      updateWaStatusPanel("disconnected");
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

  // O evento socket é instantâneo, mas a consulta REST mantém o QR disponível
  // mesmo quando o painel perdeu o evento ou foi aberto depois da geração.
  function bindQrSocket() {
    if (typeof socket === "undefined" || !socket) return;

    socket.on("qr_code", ({ qr } = {}) => {
      if (!qr) return;
      updateWaStatusPanel("qr");
      renderWaQr(qr);
      waitForWaQr();
    });

    socket.on("whatsapp_status", ({ status } = {}) => {
      if (status === "connected") {
        stopRecoveryPolling();
        refreshWaStatus();
      } else if (status === "disconnected" || status === "logged_out") {
        refreshWaStatus();
      }
    });
  }

  // Substitui apenas a ação de reconexão do painel. A diferença principal é
  // que não depende de um único setTimeout de 2,5s para encontrar o QR.
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

  // O arquivo é carregado depois de 12-socket.js no bundle, então o socket
  // já existe quando este código é executado. O intervalo REST continua sendo
  // a fonte de recuperação quando o evento efêmero não chega ao navegador.
  bindQrSocket();
  startWaStatusPolling();
})();
