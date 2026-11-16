// Envio do CSV importado para o catálogo na VPS (best-effort).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _enviarParaVps } = require('../scripts/x2-estoque-export');

const csv = path.join(os.tmpdir(), 'teste-enviar-vps.csv');
beforeAll(() => fs.writeFileSync(csv, 'a;b\n1;2\n'));
afterAll(() => fs.rmSync(csv, { force: true }));
beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); delete process.env.CATALOGO_VPS_URL; delete process.env.CATALOGO_VPS_TOKEN; });
afterEach(() => { jest.restoreAllMocks(); delete global.fetch; });

test('sem configuração não envia nada', async () => {
  global.fetch = jest.fn();
  expect(await _enviarParaVps(csv, 'DIST')).toBe('vps_nao_configurada');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('envia CSV com empresa e token', async () => {
  process.env.CATALOGO_VPS_URL = 'https://catalogo.exemplo.tech/';
  process.env.CATALOGO_VPS_TOKEN = 'segredo';
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ empresa: 'DIST', total: 5 }) });
  expect(await _enviarParaVps(csv, 'DIST')).toBe('vps_ok');
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toBe('https://catalogo.exemplo.tech/api/catalogo/estoque/importar?empresa=DIST');
  expect(opts.headers['X-Interno-Token']).toBe('segredo');
});

test('recusa ou falha de rede não derruba a rotina', async () => {
  process.env.CATALOGO_VPS_URL = 'https://x.tech';
  process.env.CATALOGO_VPS_TOKEN = 't';
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'negado' }) });
  expect(await _enviarParaVps(csv)).toBe('vps_recusou');
  global.fetch = jest.fn().mockRejectedValue(new Error('rede'));
  expect(await _enviarParaVps(csv, 'EC')).toBe('vps_falha');
});
