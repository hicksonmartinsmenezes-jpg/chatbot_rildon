#!/usr/bin/env node
/**
 * scripts/relatorio-mensal.js
 *
 * PEDIDO DO USUÁRIO (2026-09-30): relatório de fim de mês em PDF, enviado por
 * WhatsApp ao número ALERTA_WHATSAPP_NUMERO. Gera DOIS PDFs:
 *   1) Atendimento — o mesmo PDF do painel de Métricas (GET /api/metrics/
 *      exportar-pdf?mes=AAAA-MM), gerado pelo bot.
 *   2) Operação X2 — lançamentos do mês, rotinas, estoque/preço, alertas
 *      disparados e saúde do sistema (montado aqui com pdfkit).
 *
 * Uso:
 *   node scripts/relatorio-mensal.js                 # mês corrente, envia
 *   node scripts/relatorio-mensal.js --mes=2026-09   # mês específico
 *   node scripts/relatorio-mensal.js --sem-enviar    # só gera os PDFs
 * O agendamento (último dia do mês, 20h; e recuperação no dia 1º) fica em
 * scripts/x2-painel/server.js e usa verificarEEnviarSeDevido().
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const RELATORIOS_DIR = path.join(WORK_DIR, 'relatorios');
const ALERTAS_LOG = path.join(WORK_DIR, 'alertas-enviados.jsonl');
const TZ = process.env.TZ_NEGOCIO || 'America/Maceio';
const BOT = `http://localhost:${Number(process.env.PORT || 3000)}`;

function partesAgora(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { ano: +p.year, mes: +p.month, dia: +p.day, hora: +p.hour };
}
const mesStr = (ano, mes) => `${ano}-${String(mes).padStart(2, '0')}`;
function diasNoMes(ano, mes) { return new Date(ano, mes, 0).getDate(); }

/** Decide se é hora de enviar. Retorna o "AAAA-MM" a enviar ou null. */
function mesDevido(d = new Date()) {
  const a = partesAgora(d);
  const ultimoDia = a.dia === diasNoMes(a.ano, a.mes);
  if (ultimoDia && a.hora >= 20) return mesStr(a.ano, a.mes);
  // recuperação: painel fechado no fim do mês → envia o mês anterior no dia 1º (>= 8h)
  if (a.dia === 1 && a.hora >= 8) {
    const ano = a.mes === 1 ? a.ano - 1 : a.ano;
    const mes = a.mes === 1 ? 12 : a.mes - 1;
    return mesStr(ano, mes);
  }
  return null;
}
const marcador = (mes) => path.join(RELATORIOS_DIR, `enviado-${mes}.txt`);

function registrarAlertaEnviado(msg) {
  try { fs.mkdirSync(WORK_DIR, { recursive: true }); fs.appendFileSync(ALERTAS_LOG, JSON.stringify({ quando: new Date().toISOString(), msg }) + '\n'); } catch { /* best-effort */ }
}
function lerAlertasDoMes(mes) {
  try {
    return fs.readFileSync(ALERTAS_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a.quando.startsWith(mes));
  } catch { return []; }
}

async function baixarPdfAtendimento(mes) {
  const token = process.env.API_TOKEN;
  if (!token) throw new Error('API_TOKEN não configurado no .env.');
  const r = await fetch(`${BOT}/api/metrics/exportar-pdf?mes=${mes}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Bot recusou o PDF de atendimento (HTTP ${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

/** Compara o estoque do início do mês (último snapshot ANTES do dia 1º, ou o 1º do mês se não houver)
 * com o último snapshot do mês. novos = estão só no final; sumiram = estavam no início e não estão mais no X2. */
function compararSnapshots(mes) {
  const dir = path.join(WORK_DIR, 'estoque');
  const vazio = { novos: [], sumiram: [], snapshots: null };
  if (!fs.existsSync(dir)) return { ...vazio, aviso: 'Nenhum export de estoque encontrado nesta máquina.' };
  const arqs = fs.readdirSync(dir).filter((f) => /^estoque-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.csv$/.test(f)).sort();
  const dataDe = (f) => f.slice(8, 18);
  const [ano, m] = mes.split('-').map(Number);
  const ultimo = `${mes}-${String(diasNoMes(ano, m)).padStart(2, '0')}`;
  const antes = arqs.filter((f) => dataDe(f) < `${mes}-01`);
  const noMes = arqs.filter((f) => dataDe(f) >= `${mes}-01` && dataDe(f) <= ultimo);
  const base = antes.length ? antes[antes.length - 1] : noMes[0];
  const final = noMes.length ? noMes[noMes.length - 1] : null;
  if (!base || !final || base === final) {
    return { ...vazio, aviso: 'Sem dois exports de estoque para comparar neste mês (precisa de um do início e outro do fim do mês).' };
  }
  const { parseCsvEstoque } = require('../src/services/estoque.service');
  const ler = (f) => new Map(parseCsvEstoque(fs.readFileSync(path.join(dir, f), 'utf8')).map((r) => [String(r.codigo), r]));
  const mBase = ler(base), mFinal = ler(final);
  if (mBase.size < 1000 || mFinal.size < 1000) {
    return { ...vazio, aviso: 'Um dos exports parece incompleto (poucos itens) — comparação ignorada para não gerar falso resultado.' };
  }
  const novos = [...mFinal.values()].filter((r) => !mBase.has(String(r.codigo)));
  const sumiram = [...mBase.values()].filter((r) => !mFinal.has(String(r.codigo)));
  return { novos, sumiram, aviso: null, snapshots: { base, final } };
}

function coletarDadosX2(mes) {
  const d = { mes, lancamentos: [], sumiram: [], snapshots: null, avisoLanc: null, rotinas: [], estoque: null, alertas: lerAlertasDoMes(mes), saude: [] };
  try {
    const r = compararSnapshots(mes);
    d.lancamentos = r.novos; d.sumiram = r.sumiram; d.avisoLanc = r.aviso; d.snapshots = r.snapshots;
  } catch (e) { d.avisoLanc = `Não consegui comparar os estoques: ${String(e.message).split('\n')[0]}`; }
  try {
    d.rotinas = require('./x2-painel/rotinas').carregarRotinas();
  } catch { /* sem rotinas */ }
  try {
    const csv = path.join(__dirname, '..', 'src', 'data', 'estoque-latest.csv');
    const st = fs.statSync(csv);
    const linhas = fs.readFileSync(csv, 'utf8').split('\n').filter(Boolean).length - 1;
    d.estoque = { atualizadoEm: st.mtime, idadeH: Math.round((Date.now() - st.mtimeMs) / 3600000), linhas };
  } catch { d.estoque = null; }
  return d;
}

async function coletarSaude() {
  const out = [];
  try {
    const { execFileSync } = require('child_process');
    const s = execFileSync('docker', ['stats', '--no-stream', '--format', '{{.Name}}: CPU {{.CPUPerc}}, memória {{.MemUsage}}'], { timeout: 20000 }).toString().trim();
    out.push(...s.split('\n').filter(Boolean));
  } catch { out.push('Docker: não consegui consultar (docker stats indisponível).'); }
  try {
    const token = process.env.API_TOKEN;
    const r = await fetch(`${BOT}/api/whatsapp/status`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (r.ok) { const j = await r.json(); out.push(`WhatsApp do bot: ${j.connected || j.isWhatsAppConnected || j.status || JSON.stringify(j).slice(0, 80)}`); }
    else out.push(`WhatsApp do bot: status indisponível (HTTP ${r.status}).`);
  } catch (e) { out.push(`Bot fora do ar? (${e.message})`); }
  return out;
}

/* ── PDF de operação: MESMO template do relatório de métricas do bot
 * (src/services/metrics-pdf.service.js): papel timbrado, título em preto,
 * faixas azuis, cartões KPI brancos, tabelas zebradas, "Página N". ───── */
const FUNDO_PATH = path.join(__dirname, '..', 'src', 'assets', 'metricas-papel-timbrado.png');
const MARGIN = 36, TITULO_Y = 170, SUBTITULO_Y = 196, TOP = 230, TOP_CONT = 120, BOTTOM = 48;
const C = { AZUL_TITULO: '#1c4894', AZUL_BORDA: '#d6e5ee', TEXTO: '#263238', SEC: '#66717b', LINHA: '#e3e8ec', CARD: '#ffffff', CINZA: '#f5f7f9', VERDE: '#16803c', VERMELHO: '#c62828', AMARELO: '#b26a00' };
const MESES_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

function gerarPdfX2(dados) {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const bufs = [];
    doc.on('data', (b) => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    doc.on('error', reject);

    let fundo = null;
    try { fundo = fs.readFileSync(FUNDO_PATH); } catch { /* sem papel timbrado: segue sem fundo */ }
    const fmt = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
    const brl = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
    const [anoR, mesR] = dados.mes.split('-').map(Number);
    const nomeMes = `${MESES_PT[mesR - 1]}/${anoR}`;
    const agora = new Date();
    const geradoEm = agora.toLocaleDateString('pt-BR', { timeZone: TZ }) + ' ' + agora.toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
    const W0 = 595.28 - MARGIN * 2;
    const gap = 8;
    let nPag = 0;

    function pagina() {
      nPag += 1;
      doc.addPage();
      if (fundo) doc.image(fundo, 0, 0, { width: doc.page.width, height: doc.page.height });
      if (nPag === 1) {
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(18).text('RELATÓRIO MENSAL — OPERAÇÃO', MARGIN, TITULO_Y, { width: W0, align: 'center', lineBreak: false });
        doc.fillColor(C.SEC).font('Helvetica').fontSize(9).text(`Operação de ${nomeMes}  •  gerado em ${geradoEm}`, MARGIN, SUBTITULO_Y, { width: W0, align: 'center', lineBreak: false });
      }
      doc.fillColor('#7a838b').font('Helvetica').fontSize(8).text(`Página ${nPag}`, MARGIN, doc.page.height - BOTTOM, { width: W0, align: 'center', lineBreak: false });
      return nPag === 1 ? TOP : TOP_CONT;
    }
    function faixa(titulo, x, y, w) {
      doc.roundedRect(x, y, w, 22, 4).fillColor(C.AZUL_TITULO).fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10.5).text(titulo, x, y + 7.4, { width: w, align: 'center', lineBreak: false });
    }
    function cartao(x, y, w, h, titulo, valor, cor = C.TEXTO, sub = null) {
      doc.roundedRect(x, y, w, h, 5).fillColor(C.CARD).fill().lineWidth(0.7).strokeColor(C.AZUL_BORDA).stroke();
      doc.fillColor(C.SEC).font('Helvetica').fontSize(7.8).text(titulo, x + 9, y + 8, { width: w - 18 });
      doc.fillColor(cor).font('Helvetica-Bold').fontSize(13).text(String(valor), x + 9, y + 30, { width: w - 18, lineBreak: false });
      if (sub) doc.fillColor(cor).font('Helvetica-Bold').fontSize(8).text(sub, x + 9, y + 47, { width: w - 18, lineBreak: false });
    }
    // Tabela zebrada igual à do relatório de métricas. `cores` (opcional) = cor por linha p/ a última coluna.
    function tabela(x, y, w, colunas, frac, linhas, { rowH = 18, headH = 20, fonte = 8.2, align = [], cores = [] } = {}) {
      let cx = x;
      doc.roundedRect(x, y, w, headH, 3).fillColor(C.CINZA).fill();
      colunas.forEach((c, i) => { const cw = w * frac[i]; doc.fillColor(C.SEC).font('Helvetica-Bold').fontSize(fonte).text(String(c), cx + 5, y + 6, { width: cw - 10, align: align[i] || 'left', lineBreak: false }); cx += cw; });
      let cy = y + headH;
      linhas.forEach((linha, idx) => {
        if (idx % 2) doc.rect(x, cy, w, rowH).fillColor('#fbfcfd').fill();
        cx = x;
        linha.forEach((v, i) => {
          const cw = w * frac[i];
          let valor = String(v ?? '—');
          doc.font('Helvetica').fontSize(fonte);
          const limite = Math.max(8, cw - 10);
          if (doc.widthOfString(valor) > limite) { while (valor.length > 1 && doc.widthOfString(`${valor}…`) > limite) valor = valor.slice(0, -1); valor += '…'; }
          const ultima = i === colunas.length - 1 && cores[idx];
          doc.fillColor(ultima || C.TEXTO).font(ultima ? 'Helvetica-Bold' : 'Helvetica').fontSize(fonte).text(valor, cx + 5, cy + 5, { width: cw - 10, align: align[i] || 'left', lineBreak: false });
          cx += cw;
        });
        doc.moveTo(x, cy + rowH).lineTo(x + w, cy + rowH).lineWidth(0.35).strokeColor(C.LINHA).stroke();
        cy += rowH;
      });
      return cy;
    }
    // Seção = faixa + tabela, quebrando em nova página quando falta espaço (repete a faixa).
    function secao(titulo, colunas, frac, linhas, opts = {}, vazio = 'Sem dados ainda.') {
      const rowH = opts.rowH || 18;
      let y = (opts.y !== undefined) ? opts.y : (doc.y_atual);
      let restante = linhas.slice();
      let primeira = true;
      do {
        const livre = doc.page.height - BOTTOM - 14 - y - 27 - 20;
        let cabem = Math.floor(livre / rowH);
        if (cabem < 2 && restante.length) { y = pagina(); continue; }
        faixa(primeira ? titulo : `${titulo} (continuação)`, MARGIN, y, W0);
        if (!restante.length) {
          doc.fillColor('#8a939b').font('Helvetica-Oblique').fontSize(8.2).text(vazio, MARGIN + 6, y + 32, { width: W0 });
          y = y + 52; break;
        }
        const lote = restante.slice(0, cabem);
        const coresLote = (opts.cores || []).slice(linhas.length - restante.length, linhas.length - restante.length + lote.length);
        y = tabela(MARGIN, y + 27, W0, colunas, frac, lote, { ...opts, cores: coresLote }) + 16;
        restante = restante.slice(lote.length);
        primeira = false;
        if (restante.length) y = pagina();
      } while (restante.length);
      doc.y_atual = y;
      return y;
    }

    // ── Página 1: resumo (cartões) ──
    let y = pagina();
    faixa(`Resumo de ${nomeMes}`, MARGIN, y, W0);
    const cards = [
      ['Produtos novos', dados.lancamentos.length, C.TEXTO, dados.snapshots ? 'entraram no X2 no mês' : null],
      ['Produtos que sumiram do X2', dados.sumiram.length, dados.sumiram.length ? C.VERMELHO : C.VERDE, dados.snapshots ? 'saíram do X2 no mês' : null],
    ];
    const PORLINHA = 2, cardW = (W0 - gap * (PORLINHA - 1)) / PORLINHA, cardH = 66, cardsY = y + 30;
    cards.forEach((c, i) => cartao(MARGIN + (i % PORLINHA) * (cardW + gap), cardsY + Math.floor(i / PORLINHA) * (cardH + gap), cardW, cardH, c[0], c[1], c[2], c[3] || null));
    doc.y_atual = cardsY + Math.ceil(cards.length / PORLINHA) * (cardH + gap) + 10;

    // Produtos novos
    secao(`Produtos novos (${dados.lancamentos.length})`, ['Código', 'Descrição', 'Fornecedor', 'Preço varejo'], [0.13, 0.52, 0.17, 0.18],
      dados.lancamentos.slice(0, 150).map((p) => [p.codigo || '?', p.descricao || '', p.codFornecedor || '—', brl(p.precoVendaVarejo)]),
      { y: doc.y_atual, align: ['left', 'left', 'left', 'right'] }, dados.avisoLanc || 'Nenhum produto novo no mês.');

    // Produtos que sumiram do X2
    secao(`Produtos que sumiram do X2 (${dados.sumiram.length})`, ['Código', 'Descrição', 'Fornecedor', 'Preço varejo'], [0.13, 0.52, 0.17, 0.18],
      dados.sumiram.slice(0, 150).map((p) => [p.codigo || '?', p.descricao || '', p.codFornecedor || '—', brl(p.precoVendaVarejo)]),
      { y: doc.y_atual, align: ['left', 'left', 'left', 'right'] }, dados.avisoLanc || 'Nenhum produto saiu do X2 no mês.');

    // Rotinas
    secao('Rotinas do Painel X2', ['Rotina', 'Tipo', 'Última execução', 'Resultado'], [0.30, 0.17, 0.18, 0.35],
      dados.rotinas.map((r) => [r.nome || '—', r.tipo || '—', fmt(r.ultimaExecucao), r.ultimoResultado === 'erro' ? `Erro: ${String(r.ultimoErro || '').slice(0, 80)}` : r.ultimoResultado ? 'Sucesso' : 'Nunca rodou']),
      { y: doc.y_atual, cores: dados.rotinas.map((r) => (r.ultimoResultado === 'erro' ? C.VERMELHO : r.ultimoResultado ? C.VERDE : C.SEC)) }, 'Nenhuma rotina cadastrada.');

    // Alertas
    secao(`Alertas disparados no mês (${dados.alertas.length})`, ['Quando', 'Alerta'], [0.16, 0.84],
      dados.alertas.slice(-40).map((a) => [fmt(a.quando), String(a.msg).replace(/\s+/g, ' ')]), { y: doc.y_atual }, 'Nenhum alerta registrado no mês.');

    // Saúde do sistema
    secao('Saúde do sistema (na hora da geração)', ['Item'], [1], dados.saude.map((l) => [l]), { y: doc.y_atual }, 'Sem dados.');

    doc.end();
  });
}

async function gerarRelatorios(mes) {
  fs.mkdirSync(RELATORIOS_DIR, { recursive: true });
  const dados = coletarDadosX2(mes);
  dados.saude = await coletarSaude();
  const arquivos = [];
  const pdfX2 = await gerarPdfX2(dados);
  const caminhoX2 = path.join(RELATORIOS_DIR, `operacao-x2-${mes}.pdf`);
  fs.writeFileSync(caminhoX2, pdfX2);
  arquivos.push({ caminho: caminhoX2, legenda: `Operação X2 e bot — ${mes}` });
  const erros = [];
  try {
    const pdfAt = await baixarPdfAtendimento(mes);
    const caminhoAt = path.join(RELATORIOS_DIR, `atendimento-${mes}.pdf`);
    fs.writeFileSync(caminhoAt, pdfAt);
    arquivos.unshift({ caminho: caminhoAt, legenda: `Atendimento — ${mes}` });
  } catch (e) { erros.push(`PDF de atendimento: ${e.message}`); }
  return { arquivos, erros, dados };
}

async function enviarRelatorioMensal(mes, { enviar = true } = {}) {
  const { arquivos, erros, dados } = await gerarRelatorios(mes);
  if (!enviar) return { arquivos, erros, enviado: false };
  const { enviarAlertaWhatsApp, enviarDocumentoWhatsApp, formatarAlerta } = require('./x2-whatsapp-alerta');
  const comErro = dados.rotinas.filter((r) => r.ultimoResultado === 'erro').length;
  const linhas = [
    `Produtos novos: ${dados.lancamentos.length}`,
    `Produtos que sumiram do X2: ${dados.sumiram.length}`,
    `Alertas disparados: ${dados.alertas.length}`,
    `Rotinas com erro: ${comErro}`,
    dados.estoque ? `Estoque atualizado há ${dados.estoque.idadeH} h` : 'Estoque: arquivo não encontrado',
    `PDFs em anexo: ${arquivos.map((a) => a.legenda.split(' — ')[0]).join(' e ')}`,
  ];
  erros.forEach((e) => linhas.push(`Atenção — ${e}`));
  await enviarAlertaWhatsApp(formatarAlerta({ nivel: erros.length || comErro ? 'aviso' : 'ok', titulo: `Relatório mensal — ${mes}`, linhas }));
  for (const a of arquivos) await enviarDocumentoWhatsApp(a.caminho, a.legenda);
  fs.writeFileSync(marcador(mes), new Date().toISOString());
  return { arquivos, erros, enviado: true };
}

let _emAndamento = false;
/** Chamado pelo agendador do painel (a cada 15 min). Nunca lança. */
async function verificarEEnviarSeDevido() {
  if (_emAndamento) return;
  const mes = mesDevido();
  if (!mes || fs.existsSync(marcador(mes))) return;
  _emAndamento = true;
  try {
    console.log(`[relatorio-mensal] enviando relatório de ${mes}...`);
    await enviarRelatorioMensal(mes);
    console.log('[relatorio-mensal] enviado.');
  } catch (e) {
    console.error('[relatorio-mensal] falhou (tenta de novo em 15 min):', e.message);
  } finally { _emAndamento = false; }
}

module.exports = { gerarPdfX2, enviarRelatorioMensal, verificarEEnviarSeDevido, registrarAlertaEnviado, mesDevido, gerarRelatorios };

if (require.main === module) {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
  const a = partesAgora();
  const mes = arg('mes') || mesStr(a.ano, a.mes);
  enviarRelatorioMensal(mes, { enviar: !process.argv.includes('--sem-enviar') })
    .then((r) => { console.log(r.enviado ? 'Enviado:' : 'Gerado:', r.arquivos.map((x) => x.caminho).join('\n  '), r.erros.length ? `\nAvisos: ${r.erros.join('; ')}` : ''); })
    .catch((e) => { console.error('Erro:', e.message); process.exit(1); });
}
