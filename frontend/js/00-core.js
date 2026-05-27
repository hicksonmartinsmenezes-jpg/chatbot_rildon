// 00-core.js
// Arquivo modularizado automaticamente a partir do app.js original.

// ─── Estado Global ────────────────────────────────────────────────────────────
const BASE = window.location.origin;

let currentTab             = "dashboard";
let lastTicketTotal        = 0;
let firstLoadTickets       = true;
let selectedConversationUser = null;
let allHistory             = [];
let currentChatUser        = null;
let unreadMessages         = {};
let chartStatus            = null;
let chartSector            = null;
let sendingConversationMessage = false;
let metricDayChart = null;
