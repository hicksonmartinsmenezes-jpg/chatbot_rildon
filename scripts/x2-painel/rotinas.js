#!/usr/bin/env node
/**
 * scripts/x2-painel/rotinas.js
 *
 * PEDIDO DO USUÁRIO (2026-08-06): "Preciso que eu possa definir rotinas seja
 * pra procurar fotos de produtos novas ou procurar produtos" — este módulo
 * guarda as rotinas (agendamentos recorrentes de "baixar fotos" ou "sync de
 * produtos novos") e decide quando cada uma deve rodar. O agendador de
 * verdade (o `setInterval` que checa isso a cada minuto e dispara a ação)
 * fica em server.js — aqui só tem armazenamento + regras de data/hora, de
 * propósito separado pra dar pra testar sem precisar de servidor nem relógio
 * real (toda função de data recebe `agora` como parâmetro).
 *
 * ─── Onde fica salvo ────────────────────────────────────────────────────
 * `~/.x2-rildon-scraper/rotinas.json` — MESMA pasta (fora do OneDrive) que
 * o scraper já usa pro perfil do Chrome e o progresso, pelo mesmo motivo:
 * não é informação que precisa estar versionada no git nem sincronizada.
 *
 * ─── ⚠️ Trava importante, revelada pelo usuário (2026-08-06) ─────────────
 * O X2 tem timeout de sessão de login — uma rotina rodando de madrugada sem
 * ninguém na frente do computador NÃO pode contar com uma janela de Chrome
 * já aberta e logada, porque ela pode ter caído sozinha nesse meio tempo.
 * Por isso toda execução de rotina passa `modoAutomatico: true` pro scraper/
 * sync (ver x2-fotos-scraper.js e x2-catalogo-sync.js), que tenta logar
 * sozinho via X2_USUARIO/X2_SENHA (.env) a cada execução, em vez de reusar
 * sessão. Essa parte (login automático + abrir a tela certa sem clique
 * humano) ainda não foi validada numa sessão real do X2 — ver os comentários
 * nesses dois arquivos. Uma rotina pode falhar por causa disso; o campo
 * `ultimoErro` existe pra deixar isso visível no painel em vez de silencioso.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const ROTINAS_PATH = path.join(WORK_DIR, 'rotinas.json');

function garantirPasta() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// BUG REAL de PERDA DE DADOS corrigido em 2026-10-14 (auditoria do painel).
// A combinação das duas funções abaixo destruía a configuração de rotinas sem
// deixar rastro. A cadeia, reproduzida ao vivo:
//   1) salvarRotinas usava fs.writeFileSync direto. writeFileSync TRUNCA o
//      arquivo e depois escreve — uma queda no meio (máquina desligada no
//      botão, pane de energia, processo morto) deixa um JSON cortado.
//   2) carregarRotinas tinha `catch { return [] }`: o JSON cortado virava
//      silenciosamente "nenhuma rotina cadastrada". O painel mostrava a lista
//      vazia, sem nenhum aviso, e o agendador parava de rodar tudo.
//   3) qualquer criação/edição/remoção seguinte chamava carregarRotinas()
//      (recebia []), acrescentava o item novo e GRAVAVA EM CIMA — apagando de
//      verdade, e para sempre, todas as rotinas que ainda estavam no arquivo
//      cortado.
// Correção, nas duas pontas:
//   - gravação atômica: escreve num arquivo temporário ao lado e troca por
//     rename (atômico no mesmo sistema de arquivos). O arquivo final nunca
//     fica num estado meio-escrito, então o passo 1 deixa de existir. Mesmo
//     padrão que x2-estoque-export.js já usa para publicar o CSV.
//   - falha ruidosa: um arquivo ilegível não é mais tratado como "lista
//     vazia". Ele é PRESERVADO com outro nome (nunca descartado, para dar
//     chance de recuperar à mão) e o erro vai pro log em voz alta. Continua
//     devolvendo [] para não derrubar o painel, mas agora o arquivo original
//     já saiu da frente, então a gravação seguinte não sobrescreve nada.
function carregarRotinas() {
  garantirPasta();
  if (!fs.existsSync(ROTINAS_PATH)) return [];
  const bruto = fs.readFileSync(ROTINAS_PATH, 'utf8');
  try {
    const lista = JSON.parse(bruto);
    // Um JSON válido que não seja uma lista (ex: `{}` ou `null`) também não
    // serve — tratar como corrompido em vez de devolver algo inesperado para
    // quem chama, que faz .find/.filter direto no retorno.
    if (!Array.isArray(lista)) throw new Error('conteúdo não é uma lista de rotinas');
    return lista;
  } catch (e) {
    const preservado = `${ROTINAS_PATH}.corrompido-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(ROTINAS_PATH, preservado);
      console.error(
        `[x2-painel] rotinas.json ILEGÍVEL (${e.message}). O arquivo foi preservado em ${preservado} ` +
        'e NÃO foi descartado — dá pra recuperar as rotinas à mão a partir dele. O painel vai abrir ' +
        'com a lista vazia até isso ser resolvido.'
      );
    } catch (erroAoPreservar) {
      // Não conseguiu nem renomear (permissão, arquivo em uso). Melhor avisar
      // e seguir com lista vazia do que derrubar o painel — mas aqui a
      // gravação seguinte AINDA pode sobrescrever, então o aviso é mais forte.
      console.error(
        `[x2-painel] rotinas.json ILEGÍVEL (${e.message}) e não consegui preservá-lo ` +
        `(${erroAoPreservar.message}). NÃO crie nem edite rotinas antes de salvar uma cópia ` +
        `de ${ROTINAS_PATH} à mão, ou a configuração atual será sobrescrita.`
      );
    }
    return [];
  }
}

function salvarRotinas(lista) {
  garantirPasta();
  // Nome do temporário com pid + aleatório: duas instâncias do painel abertas
  // ao mesmo tempo não disputam o mesmo arquivo intermediário.
  const temporario = `${ROTINAS_PATH}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporario, JSON.stringify(lista, null, 2));
    fs.renameSync(temporario, ROTINAS_PATH);
  } catch (e) {
    try { fs.unlinkSync(temporario); } catch { /* já saiu do caminho */ }
    throw e;
  }
}

// "estoque", "painel-produtos", "diff-estoque" (2026-08-06 / 2026-08-10) e
// "cortes-produtos"/"produtos-parados" (2026-08-10, alertas de WhatsApp) não
// usam `secoes` — exportam/capturam/diffam tudo de uma vez, não seção por
// seção como baixar/sync.
const TIPOS_SEM_SECOES = ['estoque', 'painel-produtos', 'diff-estoque', 'cortes-produtos', 'produtos-parados', 'lancamentos-x2', 'drive-enviar'];

const TIPOS_VALIDOS = ['baixar', 'sync', 'estoque', 'painel-produtos', 'diff-estoque', 'cortes-produtos', 'produtos-parados', 'lancamentos-x2'];

// PEDIDO DO USUÁRIO (2026-09-11): "a proposta de exportar relatorio csv é
// capturar preços e estoque atualizados de 5 em 5 horas" — até aqui só
// existia "diaria"/"semanal" (hora fixa do relógio). "horas" é uma
// frequência nova, genérica (qualquer tipo de rotina pode usar, não só
// Estoque): roda de novo sempre que passar `intervaloHoras` horas desde a
// ÚLTIMA execução — sem hora fixa, sem `diaSemana`. Modelo mais simples e
// mais robusto a reinício do computador/painel do que tentar alinhar num
// horário de relógio: se o painel ficou fechado além do intervalo, a rotina
// dispara assim que checar de novo, em vez de esperar até a próxima "hora
// cheia" programada.
const FREQUENCIAS_VALIDAS = ['diaria', 'semanal', 'horas'];
const INTERVALO_HORAS_MAXIMO = 168; // 1 semana — além disso, "semanal" já resolve melhor.

function validarRotina(dados) {
  const erros = [];
  if (!dados.nome || !String(dados.nome).trim()) erros.push('nome é obrigatório.');
  if (!TIPOS_VALIDOS.includes(dados.tipo)) erros.push(`tipo precisa ser um de: ${TIPOS_VALIDOS.join(', ')}.`);
  if (!TIPOS_SEM_SECOES.includes(dados.tipo) && (!Array.isArray(dados.secoes) || !dados.secoes.length)) erros.push('secoes precisa ser uma lista não vazia.');
  if (!FREQUENCIAS_VALIDAS.includes(dados.frequencia)) erros.push(`frequencia precisa ser um de: ${FREQUENCIAS_VALIDAS.join(', ')}.`);
  if (dados.frequencia === 'horas') {
    const n = Number(dados.intervaloHoras);
    if (!Number.isInteger(n) || n < 1 || n > INTERVALO_HORAS_MAXIMO) {
      erros.push(`intervaloHoras precisa ser um número inteiro entre 1 e ${INTERVALO_HORAS_MAXIMO}.`);
    }
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dados.horario || '')) {
    erros.push('horario precisa estar no formato HH:MM (24h).');
  }
  if (dados.frequencia === 'semanal' && (dados.diaSemana === undefined || dados.diaSemana === null || Number(dados.diaSemana) < 0 || Number(dados.diaSemana) > 6)) {
    erros.push('diaSemana (0=domingo..6=sábado) é obrigatório pra frequência semanal.');
  }
  return erros;
}

function criarRotina(dados) {
  const erros = validarRotina(dados);
  if (erros.length) throw Object.assign(new Error(erros.join(' ')), { status: 400 });
  const lista = carregarRotinas();
  const rotina = {
    id: crypto.randomUUID(),
    nome: String(dados.nome).trim(),
    tipo: dados.tipo,
    secoes: dados.secoes || [],
    opcoes: dados.opcoes || {},
    frequencia: dados.frequencia,
    horario: dados.frequencia === 'horas' ? null : dados.horario,
    diaSemana: dados.frequencia === 'semanal' ? Number(dados.diaSemana) : null,
    intervaloHoras: dados.frequencia === 'horas' ? Number(dados.intervaloHoras) : null,
    ativa: dados.ativa !== false,
    criadaEm: new Date().toISOString(),
    ultimaExecucao: null,
    ultimoResultado: null,
    ultimoErro: null,
  };
  lista.push(rotina);
  salvarRotinas(lista);
  return rotina;
}

// PATCH parcial — dá pra mandar só `{ ativa: false }` sem reenviar a rotina
// inteira. Só revalida os campos de agendamento quando algum deles é tocado
// (ativar/desativar sozinho não precisa revalidar horário/seções etc.).
function atualizarRotina(id, mudancas) {
  const lista = carregarRotinas();
  const idx = lista.findIndex((r) => r.id === id);
  if (idx === -1) throw Object.assign(new Error('Rotina não encontrada.'), { status: 404 });
  const proposta = { ...lista[idx], ...mudancas };
  const tocouAgendamento = ['nome', 'tipo', 'secoes', 'frequencia', 'horario', 'diaSemana', 'intervaloHoras'].some((campo) => mudancas[campo] !== undefined);
  if (tocouAgendamento) {
    const erros = validarRotina(proposta);
    if (erros.length) throw Object.assign(new Error(erros.join(' ')), { status: 400 });
  }
  lista[idx] = proposta;
  salvarRotinas(lista);
  return proposta;
}

function removerRotina(id) {
  const lista = carregarRotinas();
  const nova = lista.filter((r) => r.id !== id);
  if (nova.length === lista.length) throw Object.assign(new Error('Rotina não encontrada.'), { status: 404 });
  salvarRotinas(nova);
}

/**
 * Marca que uma rotina COMEÇOU (auditoria 2026-10-14, item 5 do plano): sem
 * isso, uma execução que morre no meio não deixa rastro nenhum e o painel
 * segue exibindo o sucesso anterior como se nada tivesse acontecido.
 * Também é a referência de intervalo das rotinas "a cada N horas".
 */
function registrarInicio(id) {
  const lista = carregarRotinas();
  const idx = lista.findIndex((r) => r.id === id);
  if (idx === -1) return;
  lista[idx].ultimoInicio = new Date().toISOString();
  lista[idx].ultimoResultado = 'rodando';
  lista[idx].ultimoErro = null;
  salvarRotinas(lista);
}

// Histórico curto por rotina (2026-10-17, sessão de testes): antes só
// ficava guardado o ÚLTIMO resultado, então uma rotina que roda a cada 5h
// e falha 4x por dia aparecia como "1 execução hoje, 1 falha" — e uma
// falha da madrugada sumia assim que a execução seguinte dava certo. Sem
// isso não dá pra responder "o catálogo está sendo atualizado sozinho?",
// que é justamente o que o painel precisa mostrar. 40 entradas cobrem
// ~8 dias da rotina mais frequente (a cada 5h) e mantêm o JSON pequeno.
const LIMITE_HISTORICO_ROTINA = 40;

function registrarExecucao(id, { resultado, erro }) {
  const lista = carregarRotinas();
  const idx = lista.findIndex((r) => r.id === id);
  if (idx === -1) return;
  const agora = new Date().toISOString();
  lista[idx].ultimaExecucao = agora;
  lista[idx].ultimoResultado = resultado;
  lista[idx].ultimoErro = erro || null;
  const historico = Array.isArray(lista[idx].historico) ? lista[idx].historico : [];
  historico.unshift({
    em: agora,
    inicio: lista[idx].ultimoInicio || null,
    resultado,
    erro: erro ? String(erro).slice(0, 300) : null,
  });
  lista[idx].historico = historico.slice(0, LIMITE_HISTORICO_ROTINA);
  salvarRotinas(lista);
}

// ─── Regras de data/hora — puras, recebem `agora` como parâmetro pra dar
// pra testar sem depender do relógio real do sistema. ─────────────────────

// Fuso em que os horários das rotinas são interpretados. Antes isso era o
// fuso do PROCESSO (`setHours`), então a mesma rotina "07:50" disparava às
// 04:50 de Brasília num servidor configurado em UTC — e perdia a janela de
// recuperação da noite. Agora é sempre o fuso do negócio, igual ao resto do
// projeto (ver src/utils/horario.js).
const TZ = process.env.TZ_NEGOCIO || 'America/Maceio';

/** Diferença, em ms, entre o fuso do negócio e o UTC no instante dado. */
function _offsetDoFuso(data) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(data).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const comoSeFosseUTC = Date.UTC(
    Number(partes.year), Number(partes.month) - 1, Number(partes.day),
    Number(partes.hour) % 24, Number(partes.minute), Number(partes.second),
  );
  return comoSeFosseUTC - data.getTime();
}

/** Ano/mês/dia/dia-da-semana de um instante, lidos no fuso do negócio. */
function _civilNoFuso(data) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(data).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const semana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ano: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    diaSemana: semana[partes.weekday],
  };
}

/** Instante exato (UTC) de uma hora de parede no fuso do negócio. */
function _instanteNoFuso(ano, mes, dia, hora, minuto) {
  const chute = Date.UTC(ano, mes - 1, dia, hora, minuto, 0);
  // Duas passadas resolvem a borda de mudança de horário (o Brasil não tem
  // horário de verão hoje, mas a conta continua certa se voltar a ter).
  let instante = new Date(chute - _offsetDoFuso(new Date(chute)));
  instante = new Date(chute - _offsetDoFuso(instante));
  return instante;
}

/**
 * A ocorrência agendada MAIS RECENTE que já passou (ou null se nenhuma).
 *
 * BUG CORRIGIDO (auditoria 2026-10-14, P1): a regra antiga exigia que HOJE
 * fosse o dia da semana configurado. Se a segunda-feira passasse com o
 * painel fechado, a rotina semanal só rodava na segunda seguinte — uma
 * semana inteira de lançamentos sem cadastro, sem foto e sem PDF no Drive,
 * sem nenhum registro. Agora olha para trás até 8 dias e devolve a última
 * ocorrência devida, então a rotina perdida roda assim que o painel voltar.
 */
function ultimaOcorrenciaDevida(rotina, agora = new Date()) {
  const [h, m] = String(rotina.horario).split(':').map(Number);
  const umDiaMs = 24 * 60 * 60 * 1000;
  for (let voltar = 0; voltar <= 8; voltar++) {
    const civil = _civilNoFuso(new Date(agora.getTime() - voltar * umDiaMs));
    if (rotina.frequencia === 'semanal' && civil.diaSemana !== Number(rotina.diaSemana)) continue;
    const instante = _instanteNoFuso(civil.ano, civil.mes, civil.dia, h, m);
    if (instante <= agora) return instante;
  }
  return null;
}

function proximaExecucao(rotina, agora = new Date()) {
  // "horas" não tem hora fixa — a próxima é sempre "última execução +
  // intervaloHoras" (ou agora mesmo, se nunca rodou ainda).
  if (rotina.frequencia === 'horas') {
    const referencia = rotina.ultimoInicio || rotina.ultimaExecucao;
    if (!referencia) return new Date(agora);
    return new Date(new Date(referencia).getTime() + rotina.intervaloHoras * 60 * 60 * 1000);
  }

  // Mesma conta de fuso de deveRodarAgora — o horário é do negócio, não do
  // processo (ver comentário em TZ, acima).
  const [h, m] = String(rotina.horario).split(':').map(Number);
  const umDiaMs = 24 * 60 * 60 * 1000;
  for (let avancar = 0; avancar <= 8; avancar++) {
    const civil = _civilNoFuso(new Date(agora.getTime() + avancar * umDiaMs));
    if (rotina.frequencia === 'semanal' && civil.diaSemana !== Number(rotina.diaSemana)) continue;
    const instante = _instanteNoFuso(civil.ano, civil.mes, civil.dia, h, m);
    if (instante > agora) return instante;
  }
  return new Date(agora);
}

// Uma rotina "está pra rodar" quando: está ativa, já passou do horário
// configurado (hoje, ou hoje-é-o-dia-certo se for semanal), e ainda não
// rodou desde esse horário. O agendador em server.js chama isso a cada
// minuto — essa regra evita tanto rodar 2x na mesma janela (checagens
// repetidas dentro do mesmo minuto) quanto nunca rodar (se o servidor
// estava desligado exatamente na hora, roda na próxima checagem depois que
// religar, em vez de esperar o próximo dia).
function deveRodarAgora(rotina, agora = new Date()) {
  if (!rotina.ativa) return false;

  // "horas": não olha pra relógio nenhum — só "já passou intervaloHoras
  // desde a última vez?" (ou "nunca rodou ainda" → roda assim que a rotina
  // for checada pela 1ª vez depois de criada/ativada).
  //
  // BUG CORRIGIDO (auditoria 2026-10-14, P3): a conta saía do FIM da
  // execução anterior, então uma rotina de 5 h que leva 40 min rodava de
  // fato a cada 5h40, deslizando a cada ciclo. Agora mede a partir do
  // INÍCIO (ultimoInicio, gravado por registrarInicio) quando ele existe.
  if (rotina.frequencia === 'horas') {
    const referencia = rotina.ultimoInicio || rotina.ultimaExecucao;
    if (!referencia) return true;
    const decorridoMs = agora.getTime() - new Date(referencia).getTime();
    return decorridoMs >= rotina.intervaloHoras * 60 * 60 * 1000;
  }

  const ocorrencia = ultimaOcorrenciaDevida(rotina, agora);
  if (!ocorrencia) return false;

  // Rotina recém-criada não "deve" ocorrências anteriores à própria
  // criação — sem isso, cadastrar uma rotina de segunda numa quarta a
  // dispararia na hora.
  if (!rotina.ultimaExecucao) {
    if (rotina.criadaEm) return new Date(rotina.criadaEm) <= ocorrencia;
    // Rotina antiga, sem data de criação: mantém o critério clássico — só a
    // ocorrência do próprio dia conta, pra não disparar por uma janela
    // antiga que ninguém pediu.
    const hoje = _civilNoFuso(agora);
    const dia = _civilNoFuso(ocorrencia);
    return hoje.ano === dia.ano && hoje.mes === dia.mes && hoje.dia === dia.dia;
  }
  return new Date(rotina.ultimaExecucao) < ocorrencia;
}

module.exports = {
  WORK_DIR,
  ROTINAS_PATH,
  TIPOS_VALIDOS,
  TIPOS_SEM_SECOES,
  FREQUENCIAS_VALIDAS,
  INTERVALO_HORAS_MAXIMO,
  carregarRotinas,
  salvarRotinas,
  validarRotina,
  criarRotina,
  atualizarRotina,
  removerRotina,
  registrarInicio,
  registrarExecucao,
  proximaExecucao,
  ultimaOcorrenciaDevida,
  deveRodarAgora,
};
