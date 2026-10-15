/**
 * Smoke test de config/whatsapp.js — não existia NENHUM teste deste módulo.
 *
 * Objetivo específico: pegar qualquer erro de referência introduzido pela
 * refatoração que consolidou 8 variáveis `let` soltas (sock, isWhatsAppConnected,
 * reconnectAttempts, reconnecting, cachedConfig, lastConfigCheck, messageHandler,
 * lastQr) num único objeto de estado explícito (`conn`) — se algum ponto do
 * arquivo ainda referenciasse uma variável bare em vez de `conn.propriedade`,
 * o require já teria lançado ReferenceError, e as funções abaixo teriam
 * comportamento errado mesmo sem lançar.
 *
 * Não testa a conexão real com o WhatsApp (Baileys é mockado) — só a API
 * pública do módulo no estado inicial (antes de qualquer connectWhatsApp bem
 * sucedido), que é o estado mais fácil de exercitar sem uma sessão real.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
jest.mock("../src/services/socket.service", () => ({ emitEvent: jest.fn() }));
jest.mock("qrcode-terminal", () => ({ generate: jest.fn() }));
jest.mock("@whiskeysockets/baileys", () => ({
  __esModule: true,
  default: jest.fn(),
  // 2026-10-14: faltava aqui — src/config/whatsapp.js usa
  // makeCacheableSignalKeyStore(state.keys, ...) de verdade; sem isso no
  // mock, a chamada estourava "makeCacheableSignalKeyStore is not a
  // function" em toda suite que carrega o modulo (confirmado: mesmo erro
  // nas 7 suites que mockam este modulo).
  makeCacheableSignalKeyStore: jest.fn((keys) => keys),
  useMultiFileAuthState: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn().mockResolvedValue({ version: [2, 3000, 0] })
}));

describe("config/whatsapp — estado inicial (antes de conectar)", () => {
  test("getConnectionInfo() começa desconectado e sem QR", () => {
    const whatsapp = require("../src/config/whatsapp");
    expect(whatsapp.getConnectionInfo()).toEqual({ connected: false, qr: null });
  });

  test("isConnected() é false antes de qualquer conexão", () => {
    const whatsapp = require("../src/config/whatsapp");
    expect(whatsapp.isConnected()).toBe(false);
  });

  test("getSocket() é null antes de qualquer conexão", () => {
    const whatsapp = require("../src/config/whatsapp");
    expect(whatsapp.getSocket()).toBeNull();
  });

  test("sendMessage() rejeita com socket não inicializado", async () => {
    const whatsapp = require("../src/config/whatsapp");
    await expect(whatsapp.sendMessage("55999@s.whatsapp.net", "oi")).rejects.toThrow(/não inicializado/);
  });

  test("sendMedia() rejeita com socket não inicializado", async () => {
    const whatsapp = require("../src/config/whatsapp");
    await expect(whatsapp.sendMedia("55999@s.whatsapp.net", "/tmp/x.png")).rejects.toThrow(/não inicializado/);
  });

  test("sendTypingPresence() é no-op silencioso sem socket (não lança)", async () => {
    const whatsapp = require("../src/config/whatsapp");
    await expect(whatsapp.sendTypingPresence("55999@s.whatsapp.net")).resolves.toBeUndefined();
  });

  test("getProfilePhotoUrl() devolve null sem socket", async () => {
    const whatsapp = require("../src/config/whatsapp");
    await expect(whatsapp.getProfilePhotoUrl("55999@s.whatsapp.net")).resolves.toBeNull();
  });

  test("connectWhatsApp() exige a função processMessage", async () => {
    const whatsapp = require("../src/config/whatsapp");
    await expect(whatsapp.connectWhatsApp(undefined)).rejects.toThrow(/processMessage/);
  });

  test("forceReconnect() lança se o WhatsApp nunca foi inicializado (sem messageHandler)", async () => {
    const whatsapp = require("../src/config/whatsapp");
    await expect(whatsapp.forceReconnect()).rejects.toThrow(/não foi inicializado/);
  });
});
