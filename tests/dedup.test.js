/**
 * Testes de src/whatsapp/dedup.js — foco no dedup secundário por conteúdo
 * (isDuplicateContent).
 *
 * BUG REAL (achado em teste ao vivo, 2026-07-20): a chave `userId:text`
 * combinada com uma janela de 8s fazia o bot IGNORAR completamente a
 * segunda mensagem de um cliente que respondia o mesmo texto curto duas
 * vezes em pouco tempo para perguntas DIFERENTES (ex: "2" pra abrir o
 * submenu de Crediário, "2" de novo pra escolher uma opção dentro dele) —
 * um padrão normal de navegação por menu numerado. Sem resposta, sem
 * fallback: o cliente simplesmente parava de receber qualquer coisa do
 * bot. Corrigido reduzindo a janela pra 2s e excluindo mensagens curtas
 * (< 10 caracteres) deste dedup — a dedup por ID de mensagem
 * (marcarMensagemProcessada) continua protegendo contra duplicata real
 * do Baileys.
 */
jest.mock("../src/database/postgres", () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));

describe("dedup.js — isDuplicateContent()", () => {
  const USER_ID = "5511999999999@s.whatsapp.net";

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test("mensagens curtas (menu/dígito) NUNCA são deduplicadas, mesmo repetidas instantaneamente", () => {
    const { isDuplicateContent } = require("../src/whatsapp/dedup");

    expect(isDuplicateContent(USER_ID, "2")).toBe(false);
    expect(isDuplicateContent(USER_ID, "2")).toBe(false); // repetição imediata — não é duplicata, é 2ª pergunta

    expect(isDuplicateContent(USER_ID, "sim")).toBe(false);
    expect(isDuplicateContent(USER_ID, "sim")).toBe(false);

    expect(isDuplicateContent(USER_ID, "0")).toBe(false);
    expect(isDuplicateContent(USER_ID, "0")).toBe(false);
  });

  test("mensagem longa repetida DENTRO da janela é tratada como duplicata real (proteção original preservada)", () => {
    const { isDuplicateContent } = require("../src/whatsapp/dedup");
    const texto = "Bom dia, preciso de um orçamento para motor de partida";

    jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(isDuplicateContent(USER_ID, texto)).toBe(false); // 1ª vez — registra

    Date.now.mockReturnValue(1_000_500); // 0.5s depois, dentro da janela de 2s
    expect(isDuplicateContent(USER_ID, texto)).toBe(true); // duplicata
  });

  test("mensagem longa repetida FORA da janela não é mais tratada como duplicata", () => {
    const { isDuplicateContent } = require("../src/whatsapp/dedup");
    const texto = "Bom dia, preciso de um orçamento para motor de partida";

    jest.spyOn(Date, "now").mockReturnValue(2_000_000);
    expect(isDuplicateContent(USER_ID, texto)).toBe(false);

    Date.now.mockReturnValue(2_000_000 + 2_100); // passou dos 2s da janela
    expect(isDuplicateContent(USER_ID, texto)).toBe(false);
  });

  test("mesmo texto longo de usuários DIFERENTES não conflita entre si", () => {
    const { isDuplicateContent } = require("../src/whatsapp/dedup");
    const texto = "Quero saber sobre o crediário de vocês";

    jest.spyOn(Date, "now").mockReturnValue(3_000_000);
    expect(isDuplicateContent(USER_ID, texto)).toBe(false);
    expect(isDuplicateContent("5511888888888@s.whatsapp.net", texto)).toBe(false);
  });

  test("texto vazio/nulo não quebra e não é tratado como duplicata", () => {
    const { isDuplicateContent } = require("../src/whatsapp/dedup");
    expect(isDuplicateContent(USER_ID, "")).toBe(false);
    expect(isDuplicateContent(USER_ID, null)).toBe(false);
    expect(isDuplicateContent(USER_ID, undefined)).toBe(false);
  });
});
