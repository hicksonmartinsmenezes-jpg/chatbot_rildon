/**
 * Testes de history.controller.js — serveMediaHandler() (GET /api/history/media/:id).
 *
 * Pedido do usuário (2026-07-20): "verifique por que arquivos de mídia e
 * áudio não aparecem no meu painel". A resposta virou uma feature nova (ver
 * migration 017): salvar o arquivo em disco e servir de volta por uma rota
 * AUTENTICADA — diferente do handler público /uploads/* (fotos de
 * perfil/campanha, baixa sensibilidade), conversa de cliente é dado privado.
 * Este arquivo cobre especificamente a rota: id inválido, mídia inexistente,
 * arquivo que sumiu do disco, e o caminho feliz (headers corretos).
 */
jest.mock("../src/services/history.service", () => ({
  getHistoryById: jest.fn(),
}));
jest.mock("../src/services/mediaStorage.service", () => ({
  resolverCaminhoMidia: jest.fn(),
}));
jest.mock("fs", () => ({
  ...jest.requireActual("fs"),
  existsSync: jest.fn(),
}));

const fs = require("fs");
const { getHistoryById } = require("../src/services/history.service");
const { resolverCaminhoMidia } = require("../src/services/mediaStorage.service");
const { serveMediaHandler } = require("../src/controllers/history.controller");

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  res.sendFile = jest.fn();
  return res;
}

describe("history.controller — serveMediaHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("id não numérico → 400, nem consulta o banco", async () => {
    const req = { params: { id: "abc" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getHistoryById).not.toHaveBeenCalled();
  });

  test("linha de histórico não existe → 404", async () => {
    getHistoryById.mockResolvedValue(null);
    const req = { params: { id: "42" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  test("linha existe mas não tem mediaPath (mensagem de texto comum) → 404", async () => {
    getHistoryById.mockResolvedValue({ id: 42, mediaPath: null });
    const req = { params: { id: "42" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test("mediaPath tentando escapar de MEDIA_DIR (path traversal) → resolverCaminhoMidia devolve null → 404, nunca chama sendFile", async () => {
    getHistoryById.mockResolvedValue({ id: 42, mediaPath: "../../etc/passwd" });
    resolverCaminhoMidia.mockReturnValue(null);
    const req = { params: { id: "42" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  test("arquivo sumiu do disco (mediaPath válido mas fs.existsSync false) → 404", async () => {
    getHistoryById.mockResolvedValue({ id: 42, mediaPath: "foo-abcd1234.jpg" });
    resolverCaminhoMidia.mockReturnValue("/app/src/media-recebida/foo-abcd1234.jpg");
    fs.existsSync.mockReturnValue(false);
    const req = { params: { id: "42" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.sendFile).not.toHaveBeenCalled();
  });

  test("caminho feliz: define Content-Type do mimetype salvo e serve o arquivo", async () => {
    getHistoryById.mockResolvedValue({
      id: 42,
      mediaPath: "foo-abcd1234.jpg",
      mediaMimetype: "image/jpeg",
      mediaFilename: null,
    });
    resolverCaminhoMidia.mockReturnValue("/app/src/media-recebida/foo-abcd1234.jpg");
    fs.existsSync.mockReturnValue(true);
    const req = { params: { id: "42" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "image/jpeg");
    expect(res.sendFile).toHaveBeenCalledWith("/app/src/media-recebida/foo-abcd1234.jpg");
    expect(res.status).not.toHaveBeenCalledWith(404);
  });

  test("documento com nome original: inclui Content-Disposition inline sugerindo o nome", async () => {
    getHistoryById.mockResolvedValue({
      id: 43,
      mediaPath: "bar-efgh5678.pdf",
      mediaMimetype: "application/pdf",
      mediaFilename: "nota-fiscal.pdf",
    });
    resolverCaminhoMidia.mockReturnValue("/app/src/media-recebida/bar-efgh5678.pdf");
    fs.existsSync.mockReturnValue(true);
    const req = { params: { id: "43" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", expect.stringContaining("nota-fiscal.pdf"));
  });

  test("erro inesperado (ex: banco fora do ar) → 500, não lança exceção", async () => {
    getHistoryById.mockRejectedValue(new Error("db offline"));
    const req = { params: { id: "42" } };
    const res = mockRes();

    await serveMediaHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
