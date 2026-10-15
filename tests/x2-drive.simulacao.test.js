// Simulação do "Enviar catálogo ao Drive": lista o que enviaria e NÃO fala com o Drive.
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('rodarUploadTodosFabricantes (dryRun) e listarFabricantesDrive', () => {
  const envOriginal = { ...process.env };
  let tokenPath;

  beforeEach(() => {
    jest.resetModules();
    tokenPath = path.join(os.tmpdir(), `drive-token-${process.pid}.json`);
    fs.writeFileSync(tokenPath, '{}');
    Object.assign(process.env, {
      API_TOKEN: 'x'.repeat(70),
      GOOGLE_OAUTH_CLIENT_ID: 'id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
      GOOGLE_DRIVE_OAUTH_TOKEN_PATH: tokenPath,
      GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID: 'pasta',
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ opcoes: [
        { value: 'PERFECT' }, { value: 'PERFECT::mecanica' }, { value: 'SKF' }, { value: 'VOLDA' },
      ] }),
    }));
  });

  afterEach(() => {
    process.env = { ...envOriginal };
    try { fs.unlinkSync(tokenPath); } catch { /* ok */ }
  });

  test('simulação só lista os fabricantes escolhidos e não gera PDF', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const r = await drive.rodarUploadTodosFabricantes({ so: ['perfect', 'SKF'], dryRun: true, pausaSegundos: 0 });
    log.mockRestore();
    expect(r.fabricantes.sort()).toEqual(['PERFECT', 'SKF']);
    expect(r.enviados).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(1); // só a listagem, nenhum PDF baixado
  });

  test('listarFabricantesDrive agrupa por nome e marca os que têm Mecânica', async () => {
    const drive = require('../scripts/x2-drive-lancamentos');
    const lista = await drive.listarFabricantesDrive();
    expect(lista).toEqual([
      { nome: 'PERFECT', mecanica: true },
      { nome: 'SKF', mecanica: false },
      { nome: 'VOLDA', mecanica: false },
    ]);
  });
});
