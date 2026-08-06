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

function carregarRotinas() {
  garantirPasta();
  if (!fs.existsSync(ROTINAS_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ROTINAS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function salvarRotinas(lista) {
  garantirPasta();
  fs.writeFileSync(ROTINAS_PATH, JSON.stringify(lista, null, 2));
}

function validarRotina(dados) {
  const erros = [];
  if (!dados.nome || !String(dados.nome).trim()) erros.push('nome é obrigatório.');
  if (!['baixar', 'sync'].includes(dados.tipo)) erros.push('tipo precisa ser "baixar" ou "sync".');
  if (!Array.isArray(dados.secoes) || !dados.secoes.length) erros.push('secoes precisa ser uma lista não vazia.');
  if (!['diaria', 'semanal'].includes(dados.frequencia)) erros.push('frequencia precisa ser "diaria" ou "semanal".');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(dados.horario || '')) erros.push('horario precisa estar no formato HH:MM (24h).');
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
    secoes: dados.secoes,
    opcoes: dados.opcoes || {},
    frequencia: dados.frequencia,
    horario: dados.horario,
    diaSemana: dados.frequencia === 'semanal' ? Number(dados.diaSemana) : null,
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
  const tocouAgendamento = ['nome', 'tipo', 'secoes', 'frequencia', 'horario', 'diaSemana'].some((campo) => mudancas[campo] !== undefined);
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

function registrarExecucao(id, { resultado, erro }) {
  const lista = carregarRotinas();
  const idx = lista.findIndex((r) => r.id === id);
  if (idx === -1) return;
  lista[idx].ultimaExecucao = new Date().toISOString();
  lista[idx].ultimoResultado = resultado;
  lista[idx].ultimoErro = erro || null;
  salvarRotinas(lista);
}

// ─── Regras de data/hora — puras, recebem `agora` como parâmetro pra dar
// pra testar sem depender do relógio real do sistema. ─────────────────────

function proximaExecucao(rotina, agora = new Date()) {
  const [h, m] = rotina.horario.split(':').map(Number);
  const candidato = new Date(agora);
  candidato.setHours(h, m, 0, 0);

  if (rotina.frequencia === 'diaria') {
    if (candidato <= agora) candidato.setDate(candidato.getDate() + 1);
    return candidato;
  }

  let diffDias = (Number(rotina.diaSemana) - candidato.getDay() + 7) % 7;
  if (diffDias === 0 && candidato <= agora) diffDias = 7;
  candidato.setDate(candidato.getDate() + diffDias);
  return candidato;
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
  if (rotina.frequencia === 'semanal' && agora.getDay() !== Number(rotina.diaSemana)) return false;

  const [h, m] = rotina.horario.split(':').map(Number);
  const horarioDeHoje = new Date(agora);
  horarioDeHoje.setHours(h, m, 0, 0);
  if (agora < horarioDeHoje) return false;

  if (!rotina.ultimaExecucao) return true;
  const ultima = new Date(rotina.ultimaExecucao);
  return ultima < horarioDeHoje;
}

module.exports = {
  WORK_DIR,
  ROTINAS_PATH,
  carregarRotinas,
  salvarRotinas,
  validarRotina,
  criarRotina,
  atualizarRotina,
  removerRotina,
  registrarExecucao,
  proximaExecucao,
  deveRodarAgora,
};
