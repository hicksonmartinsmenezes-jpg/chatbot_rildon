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
 *   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET  credenciais do
 *     OAuth Client ID criado no Google Cloud Console
 *   GOOGLE_DRIVE_OAUTH_TOKEN_PATH  caminho pro token gerado uma vez por
 *     scripts/x2-drive-oauth-setup.js (autorização interativa, ver esse
 *     arquivo)
 *   GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID  ID da pasta única no Drive
 * Sem essas variáveis (ou sem o arquivo de token existir de verdade no
 * caminho indicado), o módulo AVISA no log e sai sem erro — mesmo espírito
 * do guard de API_TOKEN em _forcarReloadCatalogo(): o cadastro e as fotos
 * já foram feitos e salvos corretamente, então isso nunca pode derrubar a
 * execução por causa de uma etapa opcional/posterior ainda não configurada.
 *
 * TROCADO DE CONTA DE SERVIÇO PRA OAUTH (2026-09-16, migração concluída em
 * 2026-09-22): conta de serviço falhava com "Service Accounts do not have
 * storage quota" — não tem cota própria em pasta de Gmail pessoal, só
 * funciona com Drive Compartilhado (exclusivo de Google Workspace). Até
 * 2026-09-22 o .env já tinha sido trocado pras variáveis OAuth, mas
 * scripts/x2-drive-oauth-setup.js (referenciado desde 2026-09-16) nunca
 * tinha sido criado de fato e este arquivo ainda checava a variável antiga
 * GOOGLE_DRIVE_CREDENCIAIS_PATH — então o upload ficava sempre pendente,
 * silenciosamente (achado investigando por que um PDF não subiu ao Drive
 * depois de uma atualização de fotos/produtos em 2026-09-21).
 */

const fs = require('fs');
const path = require('path');

// Carrega .env mesmo quando este arquivo roda como script standalone (CLI
// --todos-mecanica, ver require.main === module no fim do arquivo) — quando
// importado como módulo por server.js (uso normal, encadeamento
// pós-Lançamentos), o .env já foi carregado por ele; chamar de novo aqui é
// inofensivo (dotenv não sobrescreve variável já definida).
require('dotenv').config({ path: path.join(__dirname, '../.env') });

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
// TROCADO DE CONTA DE SERVIÇO PRA OAUTH (2026-09-16, completo em 2026-09-22):
// conta de serviço falha com "Service Accounts do not have storage quota" —
// não tem cota própria em pasta de Gmail pessoal, só funciona com Drive
// Compartilhado (exclusivo de Workspace). O token OAuth (com refresh_token)
// é gerado uma vez por scripts/x2-drive-oauth-setup.js e salvo em
// GOOGLE_DRIVE_OAUTH_TOKEN_PATH — este módulo só lê o arquivo e deixa a lib
// googleapis renovar o access_token sozinha quando expira.
async function _clienteDrive(clientId, clientSecret, tokenPath) {
  if (_driveClientCache) return _driveClientCache;
  // googleapis só é exigido aqui dentro (require tardio) — assim, se a
  // dependência ainda não foi instalada (`npm install` pendente) mas as
  // variáveis de ambiente também não estão configuradas, o guard em
  // rodarUploadDrive() já saiu antes de chegar aqui, sem quebrar o resto do
  // encadeamento por causa de um `require` no topo do arquivo.
  const { google } = require('googleapis');
  const tokens = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');
  oAuth2Client.setCredentials(tokens);
  _driveClientCache = google.drive({ version: 'v3', auth: oAuth2Client });
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

// ─── Guard de configuração — checa API_TOKEN + as 4 variáveis do Drive
// (client id/secret, caminho do token OAuth, pasta) de uma vez só. Usado
// tanto pelo encadeamento automático pós-Lançamentos quanto pelo reenvio
// manual de todos os catálogos Mecânica (ver rodarUploadTodosMecanica) —
// extraído em 2026-09-22 pra não divergir se a lista de variáveis mudar de
// novo (já aconteceu uma vez, na troca conta de serviço → OAuth).
function _configDriveOuMotivo() {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken === 'troque_por_um_token_com_64_caracteres_ou_mais') {
    return { ok: false, motivo: 'API_TOKEN não configurado no .env — não dá pra consultar o catálogo do bot.' };
  }
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const tokenPath = process.env.GOOGLE_DRIVE_OAUTH_TOKEN_PATH;
  const pastaId = process.env.GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID;
  if (!clientId || !clientSecret || !tokenPath || !pastaId) {
    return { ok: false, motivo: 'GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_DRIVE_OAUTH_TOKEN_PATH / GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID não configurados no .env — ver .env.example.' };
  }
  if (!fs.existsSync(path.resolve(tokenPath))) {
    return { ok: false, motivo: `Token OAuth do Google Drive não encontrado em "${tokenPath}" — rode "node scripts/x2-drive-oauth-setup.js" pra autorizar uma vez.` };
  }
  return { ok: true, apiToken, clientId, clientSecret, tokenPath, pastaId };
}

// ─── Ponto de entrada — chamado pelo encadeamento automático pós-Lançamentos
// em server.js, com os MESMOS códigos que o Cadastro Lançamentos e o Fotos
// Lançamentos acabaram de processar.
async function rodarUploadDrive(codigos) {
  const resultado = { fabricantes: [], enviados: [], erros: [], semFabricante: [] };
  if (!codigos || !codigos.length) return resultado;

  const config = _configDriveOuMotivo();
  if (!config.ok) {
    console.log(`(${config.motivo} PDF/Drive dessa rodada ficou pendente.)`);
    return resultado;
  }

  const { BASE_URL } = require('./x2-whatsapp-alerta');

  const { fabricantes, semFabricante } = await _descobrirFabricantes(codigos, { baseUrl: BASE_URL, apiToken: config.apiToken });
  resultado.fabricantes = fabricantes;
  resultado.semFabricante = semFabricante;
  if (!fabricantes.length) {
    console.log('[x2-drive] nenhum fabricante identificado nos códigos do lançamento — nada pra subir ao Drive.');
    return resultado;
  }
  console.log(`[x2-drive] gerando e subindo PDF de ${fabricantes.length} fabricante(s) ao Drive: ${fabricantes.join(', ')}`);

  const drive = await _clienteDrive(config.clientId, config.clientSecret, path.resolve(config.tokenPath));

  for (const fabricante of fabricantes) {
    try {
      const bufferPdf = await _baixarPdfFabricante(fabricante, { baseUrl: BASE_URL, apiToken: config.apiToken });
      const envio = await _enviarPdfParaDrive(drive, config.pastaId, fabricante, bufferPdf);
      resultado.enviados.push(envio);
      console.log(`[x2-drive] ${fabricante}.pdf — ${envio.acao} no Drive.`);
    } catch (e) {
      resultado.erros.push({ fabricante, erro: e.message });
      console.error(`[x2-drive] falha ao subir PDF de "${fabricante}":`, e.message);
    }
  }

  return resultado;
}

// ─── Reenvio manual de TODOS os catálogos "- Mecânica" ao Drive — PEDIDO DO
// USUÁRIO (2026-09-22), depois de corrigir o bug em _estiloCatalogoCompleto
// (catalogo-pdf.service.js) que fazia esses PDFs saírem no estilo elétrica
// por engano: qualquer catálogo "Mecânica" já subido ANTES desse fix está
// com o layout errado no Drive, precisa ser gerado de novo com o estilo
// certo. Descobre a lista de fabricantes com opção "- Mecânica" pelo MESMO
// endpoint que o seletor do painel usa (GET /catalogo/fabricantes-completo
// — hoje 15: BASTOS, BASTOS JUNTAS, DIVERSOS, HBR, KATHO, MARVINI,
// MOBENSANI, PERFECT, RECRIN, REXON, SKF, SPEED BRAKE, VETOR, VOLDA, WISA),
// gera o PDF de cada um já com tipoCompleto=mecanica
// (?fabricante=X::mecanica — a mesma _baixarPdfFabricante aceita esse
// sufixo direto, o controller já sabe decodificar) e sobe substituindo o
// MESMO nome de arquivo de sempre ("<fabricante>.pdf", sem o sufixo
// "::mecanica" — é o nome que já existe na pasta, precisa bater pra
// substituir o errado em vez de criar um 2º arquivo).
async function rodarUploadTodosMecanica() {
  const resultado = { fabricantes: [], enviados: [], erros: [] };
  const config = _configDriveOuMotivo();
  if (!config.ok) {
    console.log(`(${config.motivo} Reenvio de catálogos Mecânica ao Drive não rodou.)`);
    resultado.erros.push({ fabricante: null, erro: config.motivo });
    return resultado;
  }

  const { BASE_URL } = require('./x2-whatsapp-alerta');

  const respostaLista = await fetch(`${BASE_URL}/api/catalogo/fabricantes-completo`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!respostaLista.ok) {
    throw new Error(`Falha ao listar fabricantes do Catálogo Completo (HTTP ${respostaLista.status}).`);
  }
  const dadosLista = await respostaLista.json();
  const opcoesMecanica = (dadosLista.opcoes || []).filter((o) => String(o.value).endsWith('::mecanica'));
  resultado.fabricantes = opcoesMecanica.map((o) => String(o.value).split('::')[0]);
  if (!opcoesMecanica.length) {
    console.log('[x2-drive] nenhum fabricante com catálogo "- Mecânica" encontrado — nada pra reenviar.');
    return resultado;
  }
  console.log(`[x2-drive] reenviando ${opcoesMecanica.length} catálogo(s) Mecânica ao Drive: ${resultado.fabricantes.join(', ')}`);

  const drive = await _clienteDrive(config.clientId, config.clientSecret, path.resolve(config.tokenPath));

  for (const opcao of opcoesMecanica) {
    const fabricanteArquivo = String(opcao.value).split('::')[0];
    try {
      const bufferPdf = await _baixarPdfFabricante(opcao.value, { baseUrl: BASE_URL, apiToken: config.apiToken });
      const envio = await _enviarPdfParaDrive(drive, config.pastaId, fabricanteArquivo, bufferPdf);
      resultado.enviados.push(envio);
      console.log(`[x2-drive] ${fabricanteArquivo}.pdf — ${envio.acao} no Drive.`);
    } catch (e) {
      resultado.erros.push({ fabricante: fabricanteArquivo, erro: e.message });
      console.error(`[x2-drive] falha ao subir PDF de "${fabricanteArquivo}":`, e.message);
    }
  }

  return resultado;
}

module.exports = { rodarUploadDrive, rodarUploadTodosMecanica };

// ─── CLI direto (2026-09-22): `node scripts/x2-drive-lancamentos.js
// --todos-mecanica` — pro usuário rodar o reenvio manual sem precisar do
// painel (útil pra rodar 1x depois de um fix de estilo, como o de hoje).
// Sem --todos-mecanica nenhuma outra ação de linha de comando existe aqui
// (rodarUploadDrive só é chamado pelo encadeamento automático em server.js).
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--todos-mecanica')) {
    rodarUploadTodosMecanica()
      .then((resultado) => {
        console.log('\n=== Resumo ===');
        console.log(`Enviados: ${resultado.enviados.length} — ${resultado.enviados.map((e) => `${e.arquivo} (${e.acao})`).join(', ') || '-'}`);
        if (resultado.erros.length) {
          console.log(`Erros: ${resultado.erros.length}`);
          resultado.erros.forEach((e) => console.log(`  - ${e.fabricante || '?'}: ${e.erro}`));
          process.exitCode = 1;
        }
      })
      .catch((e) => {
        console.error('Erro ao reenviar catálogos Mecânica:', e.message);
        process.exitCode = 1;
      });
  } else {
    console.log('Uso: node scripts/x2-drive-lancamentos.js --todos-mecanica');
  }
}
