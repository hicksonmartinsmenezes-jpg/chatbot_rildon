#!/usr/bin/env node
/**
 * scripts/x2-drive-lancamentos.js
 *
 * PEDIDO DO USUÁRIO (2026-09-11): "pretendo automatizar a geração dos pdf e
 * subir automaticamente para o drive" — 3º e último elo do encadeamento
 * automático pós-Lançamentos (ver server.js: Lançamentos → Cadastro →
 * Fotos → este módulo).
 *
 * Além do uso automático pelo fluxo de Lançamentos, este arquivo também pode
 * ser executado manualmente pelo terminal para reenviar um ou vários
 * fabricantes, ou todos os catálogos identificados pelo próprio catálogo do
 * bot. O modo manual reutiliza a mesma lógica de geração/upload do modo
 * automático; não cria uma segunda implementação.
 *
 * Comandos manuais:
 *   node scripts/x2-drive-lancamentos.js --catalogo=WEGA
 *   node scripts/x2-drive-lancamentos.js --catalogos=WEGA,OSRAM,MARZU
 *   node scripts/x2-drive-lancamentos.js --todos
 *   node scripts/x2-drive-lancamentos.js --catalogo=WEGA --dry-run
 *   node scripts/x2-drive-lancamentos.js --todos --dry-run
 *   node scripts/x2-drive-lancamentos.js --help
 *
 * O modo automático continua sendo `rodarUploadDrive(codigos)` e não depende
 * dos argumentos acima.
 */

const fs = require('fs');
const path = require('path');

function _normalizarFabricante(nome) {
  return String(nome || '').trim().replace(/\s+/g, ' ');
}

function _parsearArgumentos(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const resultado = {
    ajuda: false,
    todos: false,
    dryRun: false,
    fabricantes: [],
  };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      resultado.ajuda = true;
      continue;
    }
    if (arg === '--todos') {
      resultado.todos = true;
      continue;
    }
    if (arg === '--dry-run') {
      resultado.dryRun = true;
      continue;
    }

    const match = arg.match(/^--catalogos?=(.+)$/i);
    if (match) {
      const nomes = match[1]
        .split(',')
        .map(_normalizarFabricante)
        .filter(Boolean);
      resultado.fabricantes.push(...nomes);
      continue;
    }

    throw new Error(`Argumento desconhecido: ${arg}`);
  }

  resultado.fabricantes = [...new Set(resultado.fabricantes)];
  if (resultado.todos && resultado.fabricantes.length) {
    throw new Error('Use --todos OU --catalogo/--catalogos, não os dois juntos.');
  }
  return resultado;
}

function _mostrarAjuda() {
  console.log(`
[x2-drive] Upload manual de catálogos para o Google Drive

Uso:
  node scripts/x2-drive-lancamentos.js --catalogo=WEGA
  node scripts/x2-drive-lancamentos.js --catalogos=WEGA,OSRAM,MARZU
  node scripts/x2-drive-lancamentos.js --todos

Teste sem alterar o Drive:
  node scripts/x2-drive-lancamentos.js --catalogo=WEGA --dry-run
  node scripts/x2-drive-lancamentos.js --todos --dry-run

Observações:
  - --catalogo aceita um fabricante.
  - --catalogos aceita vários fabricantes separados por vírgula.
  - --todos descobre os fabricantes disponíveis no catálogo do bot.
  - Os fabricantes são processados sequencialmente.
  - Se o PDF já existir na pasta configurada, ele é atualizado.
  - --dry-run não cria nem atualiza arquivos no Drive.
`);
}

async function _descobrirFabricantes(codigos, { baseUrl, apiToken }) {
  const fabricantes = new Set();
  const semFabricante = [];
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

function _escaparNomeParaQuery(nome) {
  return String(nome).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

let _driveClientCache = null;
async function _clienteDrive(credenciaisPath) {
  if (_driveClientCache) return _driveClientCache;
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({
    keyFile: credenciaisPath,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  _driveClientCache = google.drive({ version: 'v3', auth });
  return _driveClientCache;
}

async function _enviarPdfParaDrive(drive, pastaId, fabricante, bufferPdf, { dryRun = false } = {}) {
  const nomeArquivo = `${fabricante}.pdf`;
  const q = `name='${_escaparNomeParaQuery(nomeArquivo)}' and '${pastaId}' in parents and trashed=false`;
  const busca = await drive.files.list({ q, fields: 'files(id, name)', spaces: 'drive' });
  const existente = (busca.data.files || [])[0];

  if (dryRun) {
    return {
      fabricante,
      arquivo: nomeArquivo,
      acao: existente ? 'seria_atualizado' : 'seria_criado',
      fileId: existente ? existente.id : null,
    };
  }

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

async function _configurarContextoDrive() {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken === 'troque_por_um_token_com_64_caracteres_ou_mais') {
    throw new Error('API_TOKEN não configurado no .env.');
  }

  const credenciaisPath = process.env.GOOGLE_DRIVE_CREDENCIAIS_PATH;
  const pastaId = process.env.GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID;
  if (!credenciaisPath || !pastaId) {
    throw new Error('GOOGLE_DRIVE_CREDENCIAIS_PATH / GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID não configurados no .env.');
  }
  if (!fs.existsSync(credenciaisPath)) {
    throw new Error(`Arquivo de credenciais do Google Drive não encontrado em "${credenciaisPath}".`);
  }

  const { BASE_URL } = require('./x2-whatsapp-alerta');
  return {
    apiToken,
    pastaId,
    baseUrl: BASE_URL,
    credenciaisPath: path.resolve(credenciaisPath),
  };
}

async function _buscarFabricantesDisponiveis({ baseUrl, apiToken }) {
  // Reutiliza o endpoint de busca do catálogo. O modo --todos precisa de uma
  // fonte de fabricantes; o endpoint de busca por código não fornece uma
  // listagem global. Portanto, usa os fabricantes presentes no índice exposto
  // pelo endpoint de catálogo, quando disponível.
  const candidatos = [
    `${baseUrl}/api/catalogo/fabricantes`,
    `${baseUrl}/api/catalogo/listar-fabricantes`,
  ];

  for (const url of candidatos) {
    try {
      const resposta = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
      if (!resposta.ok) continue;
      const dados = await resposta.json();
      const lista = Array.isArray(dados) ? dados : (dados.fabricantes || dados.data || []);
      const nomes = lista.map((item) => {
        if (typeof item === 'string') return item;
        return item && (item.fabricante || item.nome || item.name);
      }).map(_normalizarFabricante).filter(Boolean);
      if (nomes.length) return [...new Set(nomes)];
    } catch (_) {
      // Tenta a próxima forma de descoberta.
    }
  }

  throw new Error('Não foi possível descobrir a lista de fabricantes para --todos. Use --catalogos=FAB1,FAB2 ou configure um endpoint de fabricantes no painel.');
}

async function _uploadFabricantes(fabricantes, { baseUrl, apiToken, pastaId, credenciaisPath, dryRun = false }) {
  const resultado = { fabricantes: fabricantes, enviados: [], erros: [] };
  if (!fabricantes.length) return resultado;

  console.log(`[x2-drive] ${dryRun ? 'simulação: ' : ''}processando ${fabricantes.length} fabricante(s) sequencialmente: ${fabricantes.join(', ')}`);

  const drive = await _clienteDrive(credenciaisPath);
  for (const fabricante of fabricantes) {
    try {
      console.log(`[x2-drive] ${dryRun ? 'verificando' : 'gerando'} ${fabricante}.pdf...`);
      const bufferPdf = await _baixarPdfFabricante(fabricante, { baseUrl, apiToken });
      const envio = await _enviarPdfParaDrive(drive, pastaId, fabricante, bufferPdf, { dryRun });
      resultado.enviados.push(envio);
      console.log(`[x2-drive] ${fabricante}.pdf — ${envio.acao}.`);
    } catch (e) {
      resultado.erros.push({ fabricante, erro: e.message });
      console.error(`[x2-drive] falha em "${fabricante}": ${e.message}`);
    }
  }
  return resultado;
}

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
  const envio = await _uploadFabricantes(fabricantes, {
    baseUrl: BASE_URL,
    apiToken,
    pastaId,
    credenciaisPath: path.resolve(credenciaisPath),
    dryRun: false,
  });
  resultado.enviados = envio.enviados;
  resultado.erros = envio.erros;
  return resultado;
}

async function _rodarModoManual({ fabricantes, todos, dryRun }) {
  const contexto = await _configurarContextoDrive();
  let lista = fabricantes;
  if (todos) {
    lista = await _buscarFabricantesDisponiveis(contexto);
  }
  lista = [...new Set(lista.map(_normalizarFabricante).filter(Boolean))];
  if (!lista.length) throw new Error('Nenhum fabricante informado. Use --catalogo=FABRICANTE, --catalogos=A,B ou --todos.');

  const resultado = await _uploadFabricantes(lista, { ...contexto, dryRun });
  console.log('\n[x2-drive] resumo:');
  console.log(`  Processados: ${resultado.fabricantes.length}`);
  console.log(`  OK:          ${resultado.enviados.length}`);
  console.log(`  Erros:       ${resultado.erros.length}`);
  if (resultado.erros.length) process.exitCode = 1;
  return resultado;
}

async function _cli() {
  try {
    const opcoes = _parsearArgumentos(process.argv.slice(2));
    if (opcoes.ajuda) {
      _mostrarAjuda();
      return;
    }
    if (!opcoes.todos && !opcoes.fabricantes.length) {
      _mostrarAjuda();
      return;
    }
    await _rodarModoManual(opcoes);
  } catch (e) {
    console.error(`[x2-drive] erro: ${e.message}`);
    process.exitCode = 1;
  }
}

// Importado pelo servidor: somente exporta a função e NÃO inicia CLI.
// Executado diretamente: processa os argumentos manuais.
if (require.main === module) {
  _cli();
}

module.exports = { rodarUploadDrive };
