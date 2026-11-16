// Issue #85: o envio ao Drive em lote precisa (1) parar quando o painel pede
// cancelamento, (2) usar o token novo sem reiniciar o processo e (3) interromper
// o lote quando o Google responde invalid_grant. Nada aqui fala com o Drive real.
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('envio ao Drive: cancelamento e token (Issue #85)', () => {
  const envOriginal = { ...process.env };
  let tokenPath;
  let driveFactory;
  let filesCreate;

  beforeEach(() => {
    jest.resetModules();
    tokenPath = path.join(os.tmpdir(), `drive-token-cancel-${process.pid}.json`);
    fs.writeFileSync(tokenPath, '{"refresh_token":"a"}');
    Object.assign(process.env, {
      API_TOKEN: 'x'.repeat(70),
      GOOGLE_OAUTH_CLIENT_ID: 'id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_DRIVE_OAUTH_TOKEN_PATH: tokenPath,
      GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID: 'pasta',
    });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('exportar-pdf')) {
        return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
      }
      return { ok: true, json: async () => ({ opcoes: [{ value: 'AAA' }, { value: 'BBB' }, { value: 'CCC' }] }) };
    });
    filesCreate = jest.fn(async () => ({ data: { id: 'novo' } }));
    driveFactory = jest.fn(() => ({
      files: {
        list: jest.fn(async () => ({ data: { files: [] } })),
        create: filesCreate,
        update: jest.fn(async () => ({})),
      },
    }));
    jest.doMock('googleapis', () => ({
      google: {
        auth: { OAuth2: class { setCredentials() {} } },
        drive: driveFactory,
      },
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock('googleapis');
    process.env = { ...envOriginal };
    try { fs.unlinkSync(tokenPath); } catch { /* ok */ }
  });

  const pdfsGerados = () => global.fetch.mock.calls.filter(([u]) => String(u).includes('exportar-pdf')).length;

  test('cancelar no meio do lote para antes do próximo fabricante', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    const r = await drive.rodarUploadTodosFabricantes({
      pausaSegundos: 0,
      deveParar: () => filesCreate.mock.calls.length >= 1,
    });
    expect(r.cancelado).toBe(true);
    expect(r.enviados.map((e) => e.fabricante)).toEqual(['AAA']);
    expect(pdfsGerados()).toBe(1);
    expect(r.erros).toEqual([]);
  });

  test('cancelamento pedido antes de começar não envia nada', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    const r = await drive.rodarUploadTodosFabricantes({ pausaSegundos: 0, deveParar: () => true });
    expect(r.cancelado).toBe(true);
    expect(r.enviados).toEqual([]);
    expect(pdfsGerados()).toBe(0);
  });

  test('a pausa entre catálogos é interrompida pelo cancelamento', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    const inicio = Date.now();
    const r = await drive.rodarUploadTodosFabricantes({
      pausaSegundos: 60,
      deveParar: () => filesCreate.mock.calls.length >= 1,
    });
    expect(r.cancelado).toBe(true);
    expect(Date.now() - inicio).toBeLessThan(5000);
  });

  // Regressão do falso-sucesso de 27/10/2026: sem `so` nem `limite` a lista de
  // alvo era esvaziada e o reenvio completo terminava com 0 catálogos.
  test('sem cancelamento envia todos e reaproveita o cliente do Drive', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    const r = await drive.rodarUploadTodosFabricantes({ pausaSegundos: 0 });
    expect(r.cancelado).toBe(false);
    expect(r.enviados).toHaveLength(3);
    expect(driveFactory).toHaveBeenCalledTimes(1);
  });

  test('token renovado em disco é usado sem reiniciar o processo', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    await drive.rodarUploadTodosFabricantes({ so: ['AAA'], pausaSegundos: 0 });
    expect(driveFactory).toHaveBeenCalledTimes(1);
    fs.writeFileSync(tokenPath, '{"refresh_token":"token-novo-bem-diferente"}');
    await drive.rodarUploadTodosFabricantes({ so: ['AAA'], pausaSegundos: 0 });
    expect(driveFactory).toHaveBeenCalledTimes(2);
  });

  test('invalid_grant interrompe o lote e descarta o cliente em cache', async () => {
    filesCreate.mockRejectedValueOnce(new Error('invalid_grant'));
    const drive = require('../scripts/x2-drive-lancamentos');
    const r = await drive.rodarUploadTodosFabricantes({ pausaSegundos: 0 });
    expect(r.enviados).toEqual([]);
    expect(r.erros).toHaveLength(1);
    expect(r.erros[0].fabricante).toBe('AAA');
    expect(r.erros[0].erro).toMatch(/invalid_grant/);
    expect(pdfsGerados()).toBe(1); // não gerou PDF de BBB e CCC à toa

    const r2 = await drive.rodarUploadTodosFabricantes({ so: ['BBB'], pausaSegundos: 0 });
    expect(r2.enviados).toHaveLength(1);
    expect(driveFactory).toHaveBeenCalledTimes(2); // cliente recriado depois do invalid_grant
  });

  test('rodarUploadDrive (lançamentos da semana) também obedece ao cancelamento', async () => {
    global.fetch = jest.fn(async (url) => {
      const u = String(url);
      if (u.includes('buscar-codigo')) {
        const codigo = decodeURIComponent(u.split('codigo=')[1]);
        return { ok: true, json: async () => ({ produtos: [{ fabricante: `FAB-${codigo}` }] }) };
      }
      if (u.includes('exportar-pdf')) return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      return { ok: true, json: async () => ({ opcoes: [] }) };
    });
    const drive = require('../scripts/x2-drive-lancamentos');
    const r = await drive.rodarUploadDrive(['1', '2', '3'], { deveParar: () => filesCreate.mock.calls.length >= 1 });
    expect(r.cancelado).toBe(true);
    expect(r.enviados).toHaveLength(1);
  });
});
