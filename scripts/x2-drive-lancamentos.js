#!/usr/bin/env node
/**
 * scripts/x2-drive-lancamentos.js
 *
 * PEDIDO DO USUÁRIO (2026-09-11): "pretendo automatizar a geração dos pdf e
 * subir automaticamente para o drive" — 3º e último elo do encadeamento
 * automático pós-Lançamentos (ver server.js: Lançamentos → Cadastro →
 * Fotos → este módulo). Sempre que a rotina "Lançamentos X2" (toda
 * segunda-feira) captura produtos novos, este módulo:
 *   1) Descobre de QUAL(IS) fabricante(s) são esses códigos (consultando o
 *      próprio catálogo do bot, já reindexado pelo Cadastro Lançamentos que
 *      rodou antes — GET /api/catalogo/buscar-codigo).
 *   2) Pra cada fabricante tocado, gera o PDF "Catálogo Completo" (o mesmo
 *      layout oficial já usado manualmente no painel do bot, GET
 *      /api/catalogo/exportar-pdf?fabricante=X) — NÃO o "Catálogo
 *      Promocional" (visual diferente, pensado pra lista avulsa de código +
 *      preço, ver comentário em catalogo-pdf.service.js).
 *   3) Sobe (ou substitui, se já existir) "<fabricante>.pdf" numa ÚNICA
 *      pasta do Google Drive — decisão do usuário (2026-09-11, link da
 *      pasta): não é pasta por fabricante nem por mês, é uma pasta só,
 *      com um arquivo por fabricante, sempre atualizado (catálogo vivo, não
 *      um "resumo da semana").
 *
 * Reaproveita o MESMO padrão de autenticação script→bot já usado em
 * _forcarReloadCatalogo() (x2-catalogo-sync.js) e x2-estoque-export.js:
 * Authorization: Bearer API_TOKEN contra BASE_URL (ver x2-whatsapp-alerta.js).
 *
 * ─── Configuração (.env, ver .env.example) ─────────────────────────────
 *   GOOGLE_DRIVE_CREDENCIAIS_PATH  caminho pro JSON da conta de serviço
 *   GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID  ID da pasta única no Drive
 * Sem essas duas variáveis (ou sem o arquivo de credenciais existir de
 * verdade no caminho indicado), o módulo AVISA no log e sai sem erro —
 * mesmo espírito do guard de API_TOKEN em _forcarReloadCatalogo(): o
 * cadastro e as fotos já foram feitos e salvos corretamente, então isso
 * nunca pode derrubar a execução por causa de uma etapa opcional/posterior
 * ainda não configurada.
 */

const fs = require('fs');
const path = require('path');

// ─── Descoberta de fabricante(s) tocados pelos códigos do lançamento ──────
// Consulta o catálogo do PRÓPRIO bot (não o X2 de novo) — o Cadastro
// Lançamentos que roda antes já garantiu que esses códigos estão indexados,
// com `fabricante` já resolvido pela heurística de nome (ver comentário em
// catalogo-x2.service.js/_extrairFabricante — não existe campo bruto
// "fabricante" no X2, é sempre derivado do nome do produto no padrão
// "... - FABRICANTE - referência").
async function _descobrirFabricantes(codigos, { baseUrl, apiToken }) {
  const fabricantes = new Set();
  const semFabricante = [];
  // Concorrência limitada (5 por vez) — mesmo espírito de não martelar o
  // próprio bot com uma rajada de N requisições simultâneas pra N códigos
  // de um lançamento grande.
  const fila = [...codigos];
  const CONCORRENCIA = 5;
  async function worker() {
    while (fila.length) {
      const codigo = fila.shift();
      try {
        const resposta = await fetch(`${baseUrl}/api/catalogo/buscar-codigo?codigo=${encodeURIComponent(codigo)}`, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (!resposta.ok) { semFabricante.push(codigo); continue; }
        const dados = await resposta.json();
        const produto = (dados.produtos || [])[0];
        const fabricante = produto && String(produto.fabricante || '').trim();
        if (fabricante) fabricantes.add(fabricante);
        else semFabricante.push(codigo);
      } catch (e) {
        semFabricante.push(codigo);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCORRENCIA, codigos.length) }, worker));
  return { fabricantes: Array.from(fabricantes), semFabricante };
}

// ─── PDF "Catálogo Completo" de 1 fabricante, via o próprio endpoint que o
// painel do bot usa manualmente (GET /catalogo/exportar-pdf?fabricante=X) —
// reaproveita 100% da regra de negócio (filtro NCP/preço, layout oficial),
// zero duplicação de lógica de geração de PDF aqui.
async function _baixarPdfFabricante(fabricante, { baseUrl, apiToken }) {
  const resposta = await fetch(`${baseUrl}/api/catalogo/exportar-pdf?fabricante=${encodeURIComponent(fabricante)}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!resposta.ok) {
    throw new Error(`PDF de "${fabricante}" falhou (HTTP ${resposta.status}).`);
  }
  const arrayBuffer = await resposta.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─── Escapa aspas simples pro operador `q` da Drive API (sintaxe própria
// dela: \' dentro de uma string entre aspas simples).
function _escaparNomeParaQuery(nome) {
  return String(nome).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

let _driveClientCache = null;
async function _clienteDrive(credenciaisPath) {
  if (_driveClientCache) return _driveClientCache;
  // googleapis só é exigido aqui dentro (require tardio) — assim, se a
  // dependência ainda não foi instalada (`npm install` pendente) mas as
  // variáveis de ambiente também não estão configuradas, o guard em
  // rodarUploadDrive() já saiu antes de chegar aqui, sem quebrar o resto do
  // encadeamento por causa de um `require` no topo do arquivo.
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: credenciaisPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _driveClientCache = google.drive({ version: 'v3', auth });
  return _driveClientCache;
}

// ─── Sobe (ou substitui, se já existir) "<fabricante>.pdf" na pasta única
// do Drive — busca por nome dentro da pasta antes de decidir create/update,
// pra nunca duplicar arquivo do mesmo fabricante.
async function _enviarPdfParaDrive(drive, pastaId, fabricante, bufferPdf) {
  const nomeArquivo = `${fabricante}.pdf`;
  const q = `name='${_escaparNomeParaQuery(nomeArquivo)}' and '${pastaId}' in parents and trashed=false`;
  const busca = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  const existente = (busca.data.files || [])[0];
  // stream a partir do Buffer — a lib googleapis aceita Readable em `media.body`.
  const { Readable } = require('stream');
  const media = { mimeType: 'application/pdf', body: Readable.from(bufferPdf) };
  if (existente) {
    await drive.files.update({ fileId: existente.id, media });
    return { fabricante, arquivo: nomeArquivo, acao: 'atualizado', fileId: existente.id };
  }
  const criado = await drive.files.create({
    requestBody: { name: nomeArquivo, parents: [pastaId] },
    media,
    fields: 'id',
  });
  return { fabricante, arquivo: nomeArquivo, acao: 'criado', fileId: criado.data.id };
}

// ─── Ponto de entrada — chamado pelo encadeamento automático pós-Lançamentos
// em server.js, com os MESMOS códigos que o Cadastro Lançamentos e o Fotos
// Lançamentos acabaram de processar.
async function rodarUploadDrive(codigos) {
  const resultado = { fabricantes: [], enviados: [], erros: [], semFabricante: [] };
  if (!codigos || !codigos.length) return resultado;

  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken === 'troque_por_um_token_com_64_caracteres_ou_mais') {
    console.log('(API_TOKEN não configurado no .env — não deu pra consultar o catálogo do bot pra descobrir fabricante(s); PDF/Drive dessa rodada ficou pendente.)');
    return resultado;
  }
  const credenciaisPath = process.env.GOOGLE_DRIVE_CREDENCIAIS_PATH;
  const pastaId = process.env.GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID;
  if (!credenciaisPath || !pastaId) {
    console.log('(GOOGLE_DRIVE_CREDENCIAIS_PATH / GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID não configurados no .env — upload automático pro Drive ainda não foi ligado; ver .env.example.)');
    return resultado;
  }
  if (!fs.existsSync(credenciaisPath)) {
    console.log(`(Arquivo de credenciais do Google Drive não encontrado em "${credenciaisPath}" — confira GOOGLE_DRIVE_CREDENCIAIS_PATH no .env.)`);
    return resultado;
  }

  const { BASE_URL } = require('./x2-whatsapp-alerta');

  const { fabricantes, semFabricante } = await _descobrirFabricantes(codigos, { baseUrl: BASE_URL, apiToken });
  resultado.fabricantes = fabricantes;
  resultado.semFabricante = semFabricante;
  if (!fabricantes.length) {
    console.log('[x2-drive] nenhum fabricante identificado nos códigos do lançamento — nada pra subir ao Drive.');
    return resultado;
  }
  console.log(`[x2-drive] gerando e subindo PDF de ${fabricantes.length} fabricante(s) ao Drive: ${fabricantes.join(', ')}`);

  const drive = await _clienteDrive(path.resolve(credenciaisPath));

  for (const fabricante of fabricantes) {
    try {
      const bufferPdf = await _baixarPdfFabricante(fabricante, { baseUrl: BASE_URL, apiToken });
      const envio = await _enviarPdfParaDrive(drive, pastaId, fabricante, bufferPdf);
      resultado.enviados.push(envio);
      console.log(`[x2-drive] ${fabricante}.pdf — ${envio.acao} no Drive.`);
    } catch (e) {
      resultado.erros.push({ fabricante, erro: e.message });
      console.error(`[x2-drive] falha ao subir PDF de "${fabricante}":`, e.message);
    }
  }

  return resultado;
}

module.exports = { rodarUploadDrive };
