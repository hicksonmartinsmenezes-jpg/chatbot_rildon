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
//
// ACHADO 2026-10-27 (usuário: "dni tenho varios e varios produtos, no pdf
// so tem 1"): sem `fresco`, um pedido só com ?fabricante=X é servido do
// "Catálogo Completo PRONTO" — arquivo gerado 1x por semana (segunda 20h,
// ver catalogo-prontos.service.js) e reaproveitado o resto da semana, pra
// abrir na hora. O reenvio ao Drive de um lançamento no MEIO da semana
// (rodarUploadDrive, chamado automaticamente após Lançamentos/Fotos e pelo
// botão "Reenviar ao Drive (semana)") pegava esse arquivo requentado —
// sem os produtos cadastrados depois da última segunda. `fresco: true`
// soma um parâmetro extra que NÃO está na lista de permitidos do pronto
// (fabricante/_/t, ver exportarPdfHandler em catalogo.controller.js) e por
// isso o handler ignora o cache e gera o PDF na hora, com os dados atuais
// — mais lento que o pronto, mas correto. Não mexe no arquivo em cache:
// o reenvio semanal completo (rodarUploadTodosFabricantes, que já roda
// depois do reaquecimento de segunda) continua usando o pronto normal.
async function _baixarPdfFabricante(fabricante, { baseUrl, apiToken, fresco = false }) {
  const query = fresco
    ? `fabricante=${encodeURIComponent(fabricante)}&semCache=${Date.now()}`
    : `fabricante=${encodeURIComponent(fabricante)}`;
  const resposta = await fetch(`${baseUrl}/api/catalogo/exportar-pdf?${query}`, {
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
// "Diversos (todos os fabricantes)" trafega como o sentinel interno
// __DIVERSOS_TODOS_FABRICANTES__ (ver PSEUDO_FABRICANTE_DIVERSOS em
// catalogo-x2.service.js). Sem esta tradução o arquivo iria pro Drive da
// equipe com esse nome cru — achado na sessão de testes de 2026-10-17
// (ainda não tinha acontecido: a opção nunca havia sido enviada).
function _nomeArquivoFabricante(fabricante) {
  const nome = fabricante === '__DIVERSOS_TODOS_FABRICANTES__'
    ? 'DIVERSOS (todos os fabricantes)'
    : fabricante;
  return `${nome}.pdf`;
}

async function _enviarPdfParaDrive(drive, pastaId, fabricante, bufferPdf) {
  const nomeArquivo = _nomeArquivoFabricante(fabricante);
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
    resultado.erros.push({ fabricante: null, erro: config.motivo });
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

  // Auditoria 2026-09-30: fabricante que tem catálogo "- Mecânica" tem o
  // "<fabricante>.pdf" do Drive no estilo Mecânica (reenvio manual de
  // 22/09). Antes o envio automático mandava o estilo elétrica por cima.
  const mecanica = await _fabricantesComVersaoMecanica({ baseUrl: BASE_URL, apiToken: config.apiToken });

  for (const fabricante of fabricantes) {
    try {
      const valorPdf = mecanica.has(fabricante) ? `${fabricante}::mecanica` : fabricante;
      const bufferPdf = await _baixarPdfFabricante(valorPdf, { baseUrl: BASE_URL, apiToken: config.apiToken, fresco: true });
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

// Lista dos fabricantes que têm opção "- Mecânica" no Catálogo Completo.
// Best-effort: se a consulta falhar, devolve Set vazio (comportamento antigo).
async function _fabricantesComVersaoMecanica({ baseUrl, apiToken }) {
  try {
    const r = await fetch(`${baseUrl}/api/catalogo/fabricantes-completo`, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!r.ok) return new Set();
    const d = await r.json();
    return new Set((d.opcoes || []).filter((o) => String(o.value).endsWith('::mecanica')).map((o) => String(o.value).split('::')[0]));
  } catch {
    return new Set();
  }
}

// Reenvio SEMANAL de todos os catálogos (auditoria 2026-09-30): o envio
// pós-Lançamentos só cobria fabricantes com código novo, então preço, foto
// e ficha alterados em produto antigo nunca chegavam ao PDF do Drive.
// `exceto` = fabricantes que acabaram de ser enviados nesta rodada.
async function rodarUploadTodosFabricantes({ exceto = [], so = null, limite = 0, pausaSegundos = 20, dryRun = false } = {}) {
  const resultado = { fabricantes: [], enviados: [], erros: [] };
  const config = _configDriveOuMotivo();
  if (!config.ok) {
    console.log(`(${config.motivo} Reenvio completo ao Drive não rodou.)`);
    resultado.erros.push({ fabricante: null, erro: config.motivo });
    return resultado;
  }
  const { BASE_URL } = require('./x2-whatsapp-alerta');
  const respostaLista = await fetch(`${BASE_URL}/api/catalogo/fabricantes-completo`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!respostaLista.ok) throw new Error(`Falha ao listar fabricantes do Catálogo Completo (HTTP ${respostaLista.status}).`);
  const opcoes = (await respostaLista.json()).opcoes || [];
  const mecanicaBase = new Set(opcoes.filter((o) => String(o.value).endsWith('::mecanica')).map((o) => String(o.value).split('::')[0]));
  const pulados = new Set(exceto);
  // Mecânica vence quando o fabricante tem as duas versões (mesma regra do
  // reenvio manual: o "<fabricante>.pdf" do Drive é o Mecânica).
  const alvo = opcoes.filter((o) => {
    const base = String(o.value).split('::')[0];
    if (pulados.has(base)) return false;
    return String(o.value).endsWith('::mecanica') || !mecanicaBase.has(base);
  });
  // Filtros para rodar em lotes (evita sobrecarregar o bot): `so` = lista de
  // nomes (sem acento/maiúsculas não importam), `limite` = máximo por execução.
  let alvoFinal = alvo;
  if (so && so.length) {
    const alvos = new Set(so.map((n) => String(n).trim().toUpperCase()));
    alvoFinal = alvoFinal.filter((o) => alvos.has(String(o.value).split('::')[0].toUpperCase()));
  }
  if (limite > 0) alvoFinal = alvoFinal.slice(0, limite);
  alvo.length = 0; alvo.push(...alvoFinal);
  resultado.fabricantes = alvo.map((o) => String(o.value).split('::')[0]);
  if (!alvo.length) return resultado;
  if (dryRun) {
    console.log(`[x2-drive] SIMULAÇÃO — enviaria ${alvo.length} catálogo(s) ao Drive (nada foi gerado nem enviado):`);
    for (const o of alvo) {
      console.log(`  • ${_nomeArquivoFabricante(String(o.value).split('::')[0])}${String(o.value).endsWith('::mecanica') ? ' (versão Mecânica)' : ''}`);
    }
    return resultado;
  }
  console.log(`[x2-drive] reenvio completo: ${alvo.length} catálogo(s) ao Drive (1 por vez, pausa de ${pausaSegundos}s entre eles).`);
  const drive = await _clienteDrive(config.clientId, config.clientSecret, path.resolve(config.tokenPath));
  for (const opcao of alvo) {
    const nome = String(opcao.value).split('::')[0];
    // Só gera o próximo PDF se o bot estiver respondendo rápido (protege o
    // painel de atendimento — gerar PDF pesa muito no mesmo processo).
    const ok = await _aguardarBotSaudavel(BASE_URL, config.apiToken);
    if (!ok) {
      resultado.erros.push({ fabricante: nome, erro: 'bot lento/indisponível — reenvio interrompido para proteger o painel' });
      console.error('[x2-drive] bot não ficou saudável a tempo — parando aqui. Rode de novo mais tarde (com --so ou --limite).');
      break;
    }
    try {
      // Reenvio completo manual/agendado precisa refletir o catálogo atual.
      // Sem `fresco`, o endpoint pode devolver o PDF semanal em cache, que
      // ainda não inclui produtos DNI recém reconhecidos pelo parser.
      const bufferPdf = await _baixarPdfFabricante(opcao.value, { baseUrl: BASE_URL, apiToken: config.apiToken, fresco: true });
      const envio = await _enviarPdfParaDrive(drive, config.pastaId, nome, bufferPdf);
      resultado.enviados.push(envio);
      console.log(`[x2-drive] ${nome}.pdf — ${envio.acao} no Drive.`);
    } catch (e) {
      resultado.erros.push({ fabricante: nome, erro: e.message });
      console.error(`[x2-drive] falha ao subir PDF de "${nome}":`, e.message);
    }
    if (pausaSegundos > 0) await new Promise((r) => setTimeout(r, pausaSegundos * 1000));
  }
  return resultado;
}

// Ping leve no bot: precisa responder em até 3 s. Tenta até 10x, esperando 30 s entre elas.
async function _aguardarBotSaudavel(baseUrl, apiToken) {
  for (let i = 0; i < 10; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${baseUrl}/api/catalogo/fabricantes-completo`, { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(3000) });
      if (r.ok && Date.now() - t0 < 3000) return true;
    } catch { /* lento ou fora do ar */ }
    console.log('[x2-drive] bot ocupado — aguardando 30 s antes de continuar...');
    await new Promise((res) => setTimeout(res, 30000));
  }
  return false;
}

// Lista de fabricantes que o painel pode enviar ao Drive (seletor da UI).
async function listarFabricantesDrive() {
  const config = _configDriveOuMotivo();
  if (!config.ok) throw new Error(config.motivo);
  const { BASE_URL } = require('./x2-whatsapp-alerta');
  const r = await fetch(`${BASE_URL}/api/catalogo/fabricantes-completo`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Falha ao listar fabricantes do Catálogo Completo (HTTP ${r.status}).`);
  const opcoes = (await r.json()).opcoes || [];
  const mapa = new Map();
  for (const o of opcoes) {
    const nome = String(o.value).split('::')[0];
    const atual = mapa.get(nome) || { nome, mecanica: false };
    if (String(o.value).endsWith('::mecanica')) atual.mecanica = true;
    mapa.set(nome, atual);
  }
  return Array.from(mapa.values()).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

module.exports = { rodarUploadDrive, rodarUploadTodosMecanica, rodarUploadTodosFabricantes, listarFabricantesDrive };

// ─── CLI direto (2026-09-22): `node scripts/x2-drive-lancamentos.js
// --todos-mecanica` — pro usuário rodar o reenvio manual sem precisar do
// painel (útil pra rodar 1x depois de um fix de estilo, como o de hoje).
// Sem --todos-mecanica nenhuma outra ação de linha de comando existe aqui
// (rodarUploadDrive só é chamado pelo encadeamento automático em server.js).
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--verificar')) {
    // Só confere a configuração (não envia nada ao Drive nem imprime segredos).
    const c = _configDriveOuMotivo();
    console.log(c.ok ? 'Drive configurado: API_TOKEN, credenciais Google, pasta e token OAuth encontrados.' : `Drive NÃO configurado: ${c.motivo}`);
    process.exitCode = c.ok ? 0 : 1;
  } else if (args.includes('--todos')) {
    const arg = (n) => (args.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
    rodarUploadTodosFabricantes({
      so: arg('so') ? arg('so').split(',') : null,
      limite: Number(arg('limite')) || 0,
      pausaSegundos: arg('pausa') !== '' ? Number(arg('pausa')) : 20,
    })
      .then((r) => {
        console.log(`\n=== Resumo === Enviados: ${r.enviados.length} de ${r.fabricantes.length}`);
        if (r.erros.length) { r.erros.forEach((e) => console.log(`  - ${e.fabricante || '?'}: ${e.erro}`)); process.exitCode = 1; }
      })
      .catch((e) => { console.error('Erro no reenvio completo:', e.message); process.exitCode = 1; });
  } else if (args.includes('--todos-mecanica')) {
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
    console.log('Uso: node scripts/x2-drive-lancamentos.js --verificar | --todos [--so=A,B] [--limite=N] [--pausa=SEG] | --todos-mecanica');
  }
}
