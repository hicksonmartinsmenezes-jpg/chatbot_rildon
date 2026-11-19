/**
 * x2-catalogo-vps.js — envia o índice de produtos e as fotos da loja para o catálogo na VPS
 * (Issue #101, par do PR #55 de catalogo-rildon: rotas /api/catalogo/sync/*).
 *
 * Antes, só o estoque chegava sozinho à VPS; produto cadastrado e foto nova ficavam só na loja e
 * não apareciam no catalogo.exe. Aqui: pergunta à VPS o que ela já tem (manifesto com SHA-256),
 * envia só os arquivos que diferem e pede o recarregamento dos índices uma única vez no fim.
 *
 * Best-effort (mesmo critério de _enviarParaVps em x2-estoque-export.js): sem CATALOGO_VPS_URL e
 * CATALOGO_VPS_TOKEN no .env, ou com falha de rede, só registra no log e devolve um status —
 * nunca lança, para a rotina que chamou (cadastrar produtos / atualizar fotos) não quebrar.
 * Nunca apaga nada na VPS; arquivos que nascem lá (fotos-manuais, preferências de foto...) não
 * são enviados (a VPS também recusa).
 *
 * Uso manual: `npm run catalogo-enviar-vps`  (ou `node scripts/x2-catalogo-vps.js`).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CATALOGO_DIR = path.join(__dirname, '..', 'src', 'config', 'catalogo-x2');
const NOME_VALIDO = /^[a-z0-9][a-z0-9_-]*\.(json|zip)$/;
// Mesma lista de catalogo-x2.service.js (e de catalogo-rildon/src/utils/catalogo-x2-arquivos.js):
// estado/mapeamentos que NÃO são produto. Duplicada de propósito (aquele serviço indexa o catálogo
// inteiro ao ser carregado); a VPS recusa estes nomes de qualquer forma.
const ARQUIVOS_NAO_PRODUTO = new Set([
  'cod-fornecedor.json', 'aplicacao-ia-cache.json', 'fotos-preferencias.json', 'fotos-ocultas.json', 'categoria-correcoes.json',
]);
const LIMITE_CORPO_EM_MEMORIA = 64 * 1024 * 1024;

function listarLocais(dir) {
  const itens = [];
  const pastas = [
    { tipo: 'produtos', pasta: dir, ext: '.json' },
    { tipo: 'fotos', pasta: path.join(dir, 'fotos'), ext: '.zip' },
  ];
  for (const { tipo, pasta, ext } of pastas) {
    let nomes;
    try { nomes = fs.readdirSync(pasta); } catch { continue; }
    for (const nome of nomes.sort()) {
      if (!NOME_VALIDO.test(nome) || !nome.endsWith(ext)) continue;
      if (tipo === 'produtos' && ARQUIVOS_NAO_PRODUTO.has(nome)) continue;
      const caminho = path.join(pasta, nome);
      let st;
      try { st = fs.statSync(caminho); } catch { continue; }
      if (st.isFile() && st.size > 0) itens.push({ tipo, nome, caminho, tamanho: st.size });
    }
  }
  return itens;
}

function sha256Arquivo(caminho) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(caminho).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

async function enviarCatalogoParaVps({
  base = process.env.CATALOGO_VPS_URL,
  token = process.env.CATALOGO_VPS_TOKEN,
  dir = CATALOGO_DIR,
  fetchFn = fetch,
  log = console.log,
} = {}) {
  const url = String(base || '').replace(/\/+$/, '');
  if (!url || !token) {
    log('(CATALOGO_VPS_URL/CATALOGO_VPS_TOKEN não configurados no .env — produtos e fotos NÃO enviados ao catálogo da VPS.)');
    return { status: 'vps_nao_configurada', enviados: 0, iguais: 0, falhas: 0 };
  }
  const cab = { 'X-Interno-Token': token };

  try {
    const respManifesto = await fetchFn(`${url}/api/catalogo/sync/manifesto`, { headers: cab, signal: AbortSignal.timeout(180000) });
    if (!respManifesto.ok) {
      log(`(VPS recusou o manifesto do catálogo: HTTP ${respManifesto.status}.)`);
      return { status: 'vps_recusou', enviados: 0, iguais: 0, falhas: 0 };
    }
    const remoto = new Map(((await respManifesto.json()).arquivos || []).map((a) => [`${a.tipo}/${a.nome}`, a.sha256]));

    let enviados = 0; let iguais = 0; let falhas = 0;
    for (const arq of listarLocais(dir)) {
      const sha = await sha256Arquivo(arq.caminho);
      if (remoto.get(`${arq.tipo}/${arq.nome}`) === sha) { iguais++; continue; }
      try {
        const corpo = arq.tamanho <= LIMITE_CORPO_EM_MEMORIA ? fs.readFileSync(arq.caminho) : fs.createReadStream(arq.caminho);
        const resp = await fetchFn(`${url}/api/catalogo/sync/arquivo?tipo=${arq.tipo}&nome=${encodeURIComponent(arq.nome)}`, {
          method: 'PUT',
          headers: { ...cab, 'Content-Type': 'application/octet-stream', 'X-Sha256': sha },
          body: corpo,
          duplex: 'half',
          signal: AbortSignal.timeout(30 * 60 * 1000),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) { falhas++; log(`(VPS recusou ${arq.tipo}/${arq.nome}: HTTP ${resp.status} — ${json.error || 'sem detalhe'}.)`); continue; }
        enviados++;
        log(`Enviado à VPS: ${arq.tipo}/${arq.nome} (${(arq.tamanho / 1048576).toFixed(1)} MB).`);
      } catch (e) {
        falhas++;
        log(`(falha ao enviar ${arq.tipo}/${arq.nome} à VPS: ${e.message})`);
      }
    }

    let concluido = false;
    if (enviados > 0) {
      const resp = await fetchFn(`${url}/api/catalogo/sync/concluir`, { method: 'POST', headers: cab, signal: AbortSignal.timeout(120000) });
      concluido = resp.ok;
      if (!resp.ok) log(`(VPS recebeu os arquivos mas recusou recarregar os índices: HTTP ${resp.status}.)`);
    }
    log(`Catálogo na VPS: ${enviados} enviado(s), ${iguais} já iguais, ${falhas} falha(s)${enviados ? (concluido ? ', índices recarregados' : ', índices NÃO recarregados') : ''}.`);
    return { status: falhas ? 'vps_parcial' : 'vps_ok', enviados, iguais, falhas, concluido };
  } catch (e) {
    log(`(não consegui sincronizar produtos e fotos com a VPS: ${e.message})`);
    return { status: 'vps_falha', enviados: 0, iguais: 0, falhas: 0 };
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../.env') });
  enviarCatalogoParaVps().then((r) => { process.exitCode = r.status === 'vps_ok' ? 0 : 1; });
}

module.exports = { enviarCatalogoParaVps, listarLocais };
