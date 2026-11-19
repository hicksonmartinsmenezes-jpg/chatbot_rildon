// Issue #101: envio de produtos e fotos novos ao catálogo da VPS (best-effort, só o que mudou).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { enviarCatalogoParaVps, listarLocais } = require('../scripts/x2-catalogo-vps');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let dir;
let log;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-vps-'));
  fs.mkdirSync(path.join(dir, 'fotos'));
  log = jest.fn();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const gravar = (rel, conteudo) => { fs.writeFileSync(path.join(dir, rel), conteudo); return Buffer.from(conteudo); };
const resp = (status, corpo = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

// VPS falsa: devolve o manifesto dado e registra cada chamada.
function vpsFalsa({ manifesto = [], recusar = {}, concluir = 200 } = {}) {
  const chamadas = [];
  const fetchFn = jest.fn(async (url, opts = {}) => {
    const u = new URL(url);
    chamadas.push({ rota: u.pathname, nome: u.searchParams.get('nome'), tipo: u.searchParams.get('tipo'), metodo: opts.method || 'GET', sha: opts.headers && opts.headers['X-Sha256'], token: opts.headers && opts.headers['X-Interno-Token'], tamanho: opts.body && opts.body.length });
    if (u.pathname.endsWith('/manifesto')) return resp(200, { arquivos: manifesto });
    if (u.pathname.endsWith('/arquivo')) return recusar[u.searchParams.get('nome')] ? resp(recusar[u.searchParams.get('nome')], { error: 'negado pelo teste' }) : resp(200, { ok: true });
    if (u.pathname.endsWith('/concluir')) return resp(concluir, {});
    return resp(404);
  });
  return { fetchFn, chamadas };
}
const rodar = (fetchFn) => enviarCatalogoParaVps({ base: 'https://vps.exemplo/', token: 'tok', dir, fetchFn, log });
const puts = (c) => c.filter((x) => x.metodo === 'PUT').map((x) => `${x.tipo}/${x.nome}`);

test('sem URL/token no .env: não faz nada e avisa', async () => {
  const { fetchFn } = vpsFalsa();
  const r = await enviarCatalogoParaVps({ base: '', token: '', dir, fetchFn, log });
  expect(r.status).toBe('vps_nao_configurada');
  expect(fetchFn).not.toHaveBeenCalled();
});

test('VPS vazia: envia produtos e fotos, com sha256 e token, e pede o recarregamento uma vez', async () => {
  const json = gravar('alternador.json', '[{"codigo":"1"}]');
  const zip = gravar('fotos/alternador.zip', 'PK-fake-zip');
  const { fetchFn, chamadas } = vpsFalsa();
  const r = await rodar(fetchFn);

  expect(r).toMatchObject({ status: 'vps_ok', enviados: 2, iguais: 0, falhas: 0, concluido: true });
  expect(puts(chamadas)).toEqual(['produtos/alternador.json', 'fotos/alternador.zip']);
  const put = chamadas.find((c) => c.nome === 'alternador.json');
  expect(put.sha).toBe(sha(json));
  expect(put.token).toBe('tok');
  expect(chamadas.find((c) => c.nome === 'alternador.zip').sha).toBe(sha(zip));
  expect(chamadas.filter((c) => c.rota.endsWith('/concluir'))).toHaveLength(1);
});

test('só envia o que difere do manifesto da VPS; se nada mudou, nem pede recarregamento', async () => {
  const a = gravar('a.json', '[1]');
  const b = gravar('b.json', '[2]');
  const { fetchFn, chamadas } = vpsFalsa({ manifesto: [
    { tipo: 'produtos', nome: 'a.json', sha256: sha(a) },
    { tipo: 'produtos', nome: 'b.json', sha256: sha(b) },
  ] });
  const r = await rodar(fetchFn);
  expect(r).toMatchObject({ enviados: 0, iguais: 2 });
  expect(puts(chamadas)).toEqual([]);
  expect(chamadas.some((c) => c.rota.endsWith('/concluir'))).toBe(false);

  gravar('b.json', '[2,3]'); // b mudou na loja
  const { fetchFn: f2, chamadas: c2 } = vpsFalsa({ manifesto: [
    { tipo: 'produtos', nome: 'a.json', sha256: sha(a) },
    { tipo: 'produtos', nome: 'b.json', sha256: sha(b) },
  ] });
  await rodar(f2);
  expect(puts(c2)).toEqual(['produtos/b.json']);
});

test('arquivos que nascem na VPS, fotos-manuais, backups e nomes estranhos nunca são enviados', async () => {
  for (const n of ['cod-fornecedor.json', 'aplicacao-ia-cache.json', 'fotos-preferencias.json', 'fotos-ocultas.json', 'categoria-correcoes.json', 'Maiuscula.json', '.oculto.json', 'dados.txt']) gravar(n, '[]');
  gravar('fotos/secao.zip.bak-123', 'x');
  gravar('fotos/vazio.zip', '');
  fs.mkdirSync(path.join(dir, 'fotos-manuais', '123'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fotos-manuais', '123', 'a.jpg'), 'x');
  gravar('ok.json', '[]');
  expect(listarLocais(dir).map((i) => `${i.tipo}/${i.nome}`)).toEqual(['produtos/ok.json']);
});

test('uma recusa não impede os outros arquivos; resultado é parcial', async () => {
  gravar('a.json', '[1]'); gravar('b.json', '[2]'); gravar('c.json', '[3]');
  const { fetchFn, chamadas } = vpsFalsa({ recusar: { 'b.json': 422 } });
  const r = await rodar(fetchFn);
  expect(r).toMatchObject({ status: 'vps_parcial', enviados: 2, falhas: 1 });
  expect(puts(chamadas)).toEqual(['produtos/a.json', 'produtos/b.json', 'produtos/c.json']);
  expect(log.mock.calls.flat().join('\n')).toMatch(/recusou produtos\/b\.json: HTTP 422/);
});

test('manifesto recusado (token errado): status vps_recusou, sem enviar nada', async () => {
  gravar('a.json', '[1]');
  const fetchFn = jest.fn(async () => resp(403, { error: 'negado' }));
  const r = await rodar(fetchFn);
  expect(r.status).toBe('vps_recusou');
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

test('falha de rede nunca lança: devolve vps_falha', async () => {
  gravar('a.json', '[1]');
  const r = await rodar(jest.fn(async () => { throw new Error('ECONNREFUSED'); }));
  expect(r.status).toBe('vps_falha');
  expect(log.mock.calls.flat().join('\n')).toMatch(/ECONNREFUSED/);
});

test('índices não recarregados são avisados quando o concluir falha', async () => {
  gravar('a.json', '[1]');
  const { fetchFn } = vpsFalsa({ concluir: 500 });
  const r = await rodar(fetchFn);
  expect(r).toMatchObject({ enviados: 1, concluido: false });
  expect(log.mock.calls.flat().join('\n')).toMatch(/recusou recarregar os índices/);
});
