// 17-ui-events.js
// Delegação declarativa para reduzir handlers inline no HTML.
// Mantém compatibilidade com as funções globais já existentes no painel.
(function () {
  "use strict";

  function fn(name) {
    const value = window[name];
    return typeof value === "function" ? value : null;
  }

  function call(name, ...args) {
    const action = fn(name);
    if (!action) {
      console.warn(`[ui-events] Ação não encontrada: ${name}`);
      return undefined;
    }
    return action(...args);
  }

  const simpleClickActions = new Set([
    "togglePasswordVisibility",
    "refreshAll",
    "toggleTheme",
    "toggleNotifDropdown",
    "clearNotifications",
    "openProfileModal",
    "logout",
    "loadTickets",
    "loadConversations",
    "sendConversationMessage",
    "clearHistoryFilters",
    "bulkDeleteContacts",
    "openContactModal",
    "importContactsCSV",
    "exportContactsCSV",
    "contactsPagePrev",
    "contactsPageNext",
    "closeContactModal",
    "saveContact",
    "closeDeleteContactModal",
    "doDeleteContact",
    "loadCampaigns",
    "openCampaignModal",
    "closeCampaignModal",
    "removeCampaignMedia",
    "campSelectAll",
    "campClearAll",
    "createCampaign",
    "saveBotSettings",
    "addQuickReply",
    "saveFlow",
    "loadSettings",
    "loadPanelUsers",
    "saveSettings",
    "backToSettingsHome",
    "createPanelUser",
    "resetSettings",
    "requestWaReconnect",
    "loadActivityLogs",
    "loadMetricsCharts",
    "fecharChat",
    "enviarMensagemManual",
    "closeProfileModal",
    "saveProfile"
  ]);

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-submit-action]");
    if (!form) return;
    event.preventDefault();
    call(form.dataset.submitAction, event);
  });

  document.addEventListener("click", (event) => {
    const backdrop = event.target.closest("[data-backdrop-action]");
    if (backdrop && event.target === backdrop) {
      call(backdrop.dataset.backdropAction, event);
      return;
    }

    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;

    const action = trigger.dataset.action;
    if (!action) return;

    if (simpleClickActions.has(action)) {
      event.preventDefault();
      call(action, event);
      return;
    }

    if (action === "loadHistoryTrue") {
      event.preventDefault();
      call("loadHistory", true);
      return;
    }

    if (action === "toggleContactSelectAll") {
      event.preventDefault();
      const checked = trigger.dataset.checked === "true";
      call("toggleContactSelectAll", checked);
      return;
    }

    if (action === "setTicketFilter") {
      event.preventDefault();
      call("setTicketFilter", trigger.dataset.value, trigger);
      return;
    }

    if (action === "setCampaignMediaType") {
      event.preventDefault();
      call("setCampaignMediaType", trigger.dataset.value, trigger);
      return;
    }

    if (action === "switchBotPanel") {
      event.preventDefault();
      call("switchBotPanel", trigger.dataset.value, event);
      return;
    }

    if (action === "openSettingsPanel") {
      event.preventDefault();
      call("openSettingsPanel", trigger.dataset.value);
      return;
    }

    if (action === "togglePassword") {
      event.preventDefault();
      call("togglePassword", trigger.dataset.target, trigger);
    }
  });

  document.addEventListener("keydown", (event) => {
    const keyActionEl = event.target.closest("[data-keydown-action]");
    if (keyActionEl?.dataset.keydownAction === "conversationTextarea") {
      call("handleConversationKeydown", event);
      return;
    }

    if (event.key !== "Enter" && event.key !== " ") return;
    const trigger = event.target.closest('[role="button"][data-action]');
    if (!trigger) return;
    event.preventDefault();
    trigger.click();
  });

  document.addEventListener("change", (event) => {
    const el = event.target.closest("[data-change-action]");
    if (!el) return;

    switch (el.dataset.changeAction) {
      case "loadTickets":
        call("loadTickets");
        break;
      case "loadHistoryTrue":
        call("loadHistory", true);
        break;
      case "contactsFilterTag":
        call("contactsFilterTag", el.value);
        break;
      case "contactsFilterStatus":
        call("contactsFilterStatus", el.value);
        break;
      case "toggleContactSelectAll":
        call("toggleContactSelectAll", !!el.checked);
        break;
      case "filterCampaigns":
        call("filterCampaigns", el.value);
        break;
      case "previewCampaignMedia":
        call("previewCampaignMedia", event);
        break;
      case "toggleCustomRecipients":
        call("toggleCustomRecipients");
        break;
      case "updateCampaignAudienceCount":
        call("updateCampaignAudienceCount");
        break;
      case "previewProfilePhoto":
        call("previewProfilePhoto", event);
        break;
    }
  });

  document.addEventListener("input", (event) => {
    const el = event.target.closest("[data-input-action]");
    if (!el) return;

    switch (el.dataset.inputAction) {
      case "loadTickets":
        call("loadTickets");
        break;
      case "debouncedSearch":
        call("debouncedSearch");
        break;
      case "conversationTextarea":
        call("notifyTyping");
        call("autoResizeTextarea", el);
        break;
      case "loadHistoryTrue":
        call("loadHistory", true);
        break;
      case "contactsSearch":
        call("contactsSearch", el.value);
        break;
      case "updateCampaignPreview":
        call("updateCampaignPreview");
        break;
      case "updateCampaignPreviewMsgCounter":
        call("updateCampaignPreview");
        call("updateMsgCounter");
        break;
      case "searchCampContacts":
        call("searchCampContacts", el.value);
        break;
    }
  });
})();
