const { consultaCatalogoSemLogin, ipPrivado } = require("../src/middlewares/catalogo-consulta");

function chamar({ method = "GET", path = "/catalogo/buscar", headers = { "x-consulta-catalogo": "1" }, ip = "192.168.0.50", query = {} } = {}) {
  const hs = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, path, query, get: (n) => hs[n.toLowerCase()], socket: { remoteAddress: ip } };
  const roteador = jest.fn();
  const next = jest.fn();
  consultaCatalogoSemLogin(roteador)(req, {}, next);
  return { roteador, next };
}

describe("consulta do catálogo sem login", () => {
  test("libera leitura da rede interna com o cabeçalho do programa", () => {
    const r = chamar();
    expect(r.roteador).toHaveBeenCalledTimes(1);
    expect(r.next).not.toHaveBeenCalled();
  });
  test("libera fotos e exportação do PDF", () => {
    expect(chamar({ path: "/catalogo/produtos/ABC123/fotos/0" }).roteador).toHaveBeenCalled();
    expect(chamar({ path: "/catalogo/exportar-pdf" }).roteador).toHaveBeenCalled();
  });
  test("sem o cabeçalho, segue o fluxo normal (exige login)", () => {
    const r = chamar({ headers: {} });
    expect(r.roteador).not.toHaveBeenCalled();
    expect(r.next).toHaveBeenCalled();
  });
  test.each(["PUT", "DELETE", "PATCH"])("nunca libera %s", (method) => {
    expect(chamar({ method, path: "/catalogo/produtos/X/linha" }).roteador).not.toHaveBeenCalled();
  });
  // 2026-10-21: o programa do balcão também edita (fotos e Linha do produto).
  test.each([
    "/catalogo/produtos/X1/foto-preferida",
    "/catalogo/produtos/X1/foto-ocultar",
    "/catalogo/produtos/X1/linha",
    "/catalogo/produtos/X1/fotos/upload",
    "/catalogo/exportar-selecionados-pdf",
    "/catalogo/promocional/exportar-pdf",
    "/catalogo/promocional/importar-arquivo"
  ])("libera POST %s", (path) => {
    expect(chamar({ method: "POST", path }).roteador).toHaveBeenCalled();
  });
  test.each(["/catalogo/produtos/recarregar", "/catalogo/estoque/recarregar"])("POST de manutenção continua exigindo login: %s", (path) => {
    expect(chamar({ method: "POST", path }).roteador).not.toHaveBeenCalled();
  });
  test("POST sem o cabeçalho ou de IP público não entra", () => {
    expect(chamar({ method: "POST", path: "/catalogo/produtos/X1/linha", headers: {} }).roteador).not.toHaveBeenCalled();
    expect(chamar({ method: "POST", path: "/catalogo/produtos/X1/linha", ip: "200.10.20.30" }).roteador).not.toHaveBeenCalled();
  });
  test("não libera rotas fora da consulta", () => {
    expect(chamar({ path: "/tickets" }).roteador).not.toHaveBeenCalled();
    expect(chamar({ path: "/catalogo/categoria-linhas" }).roteador).not.toHaveBeenCalled();
  });
  test("não libera IP público nem acesso por proxy/túnel", () => {
    expect(chamar({ ip: "200.10.20.30" }).roteador).not.toHaveBeenCalled();
    expect(chamar({ headers: { "x-consulta-catalogo": "1", "cf-connecting-ip": "1.2.3.4" } }).roteador).not.toHaveBeenCalled();
    expect(chamar({ headers: { "x-consulta-catalogo": "1", "x-forwarded-for": "1.2.3.4" } }).roteador).not.toHaveBeenCalled();
  });
  test("ipPrivado", () => {
    ["10.1.2.3", "192.168.0.2", "172.20.0.5", "127.0.0.1", "::1", "::ffff:192.168.0.9"].forEach((ip) => expect(ipPrivado(ip)).toBe(true));
    ["8.8.8.8", "172.32.0.1", "192.169.0.1", ""].forEach((ip) => expect(ipPrivado(ip)).toBe(false));
  });
});
