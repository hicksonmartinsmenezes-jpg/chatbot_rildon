#!/usr/bin/env node
/**
 * scripts/x2-painel/server.js
 *
 * PEDIDO DO USUÁRIO (2026-08-05): "gostaria que fosse um painel mais
 * bonitinho" — em vez do menu de terminal (scripts/x2-fotos-menu.js), uma
 * telinha de verdade no navegador, com botões/checkbox de seção e barra de
 * progresso ao vivo. Decisão consciente (discutida com o usuário): NÃO é um
 * app Electron nem uma aba nova dentro do painel do bot Rildon — é um
 * servidor local pequeno e separado, porque:
 *   1) Electron seria pesado de manter só por causa disso, e a limitação
 *      real (o X2 exige um clique de verdade seu numa janela do Chrome)
 *      continua existindo de qualquer jeito, escondida ou não atrás de um
 *      app — não ganha nada em usabilidade que justifique o peso extra.
 *   2) O painel do bot Rildon já tem 9+ abas de uso diário (Atendimentos,
 *      Conversas, Métricas etc.) usadas por vários atendentes — misturar
 *      uma ferramenta de manutenção de catálogo (uso solo, ocasional) ali
 *      só polui a ferramenta que as pessoas dependem todo dia pra trabalhar.
 *
 * PEDIDO DO USUÁRIO: "ambos inteiramente ligados em relação ao Catálogo de
 * produtos" — "ligados" aqui significa MESMOS DADOS, sempre em sincronia:
 * este painel NUNCA duplica informação. Ele lê directamente:
 *   - src/config/catalogo-x2/<secao>.json      (mesmo arquivo que o painel
 *     do bot usa pra alimentar a busca do Catálogo — catalogo-x2.service.js)
 *   - src/config/catalogo-x2/fotos/<secao>.zip (mesmo índice que
 *     catalogo-fotos.service.js lê pra servir foto pro atendente pesquisar)
 *   - ~/.x2-rildon-scraper/progress/<secao>.json (checkpoint do scraper,
 *     fora do projeto — ver x2-fotos-scraper.js)
 * "Publicado" (visível na busca do Catálogo do painel do bot) e "baixado"
 * (já processado pelo scraper, mas ainda só no staging local) são números
 * DIFERENTES de propósito — ver renderStatus() no index.html — porque só
 * viram a mesma coisa depois de rodar --build-zip.
 *
 * ─── Como usar ──────────────────────────────────────────────────────────
 *   npm install                    (só na 1ª vez — Playwright, se ainda não tiver)
 *   node scripts/x2-painel/server.js
 *   (ou dê duplo-clique no atalho "Painel Fotos X2.bat" na Área de Trabalho,
 *   ver instruções no fim deste arquivo — mesmo padrão do "Atualizar Fotos
 *   X2.bat" já existente)
 * Abre sozinho em http://localhost:4123 — só funciona na sua máquina
 * (bind em 127.0.0.1 de propósito, nunca exposto na rede).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

// require('../x2-fotos-scraper') abaixo já importa 'playwright' internamente
// — se não estiver instalado (`npm install` nunca rodado), o erro aparece
// aqui, cedo e claro, em vez de estourar só quando alguém clicar "Baixar".
const scraper = require('../x2-fotos-scraper');
const sync = require('../x2-catalogo-sync');
const estoqueExport = require('../x2-estoque-export');
const painelProdutosSnapshot = require('../x2-painel-produtos-snapshot');
const cortesProdutos = require('../x2-cortes-produtos-scraper');
const curvaAbcParados = require('../x2-curva-abc-parados-scraper');
const lancamentosX2 = require('../x2-lancamentos-scraper');
// PEDIDO DO USUÁRIO (2026-09-11): 3º elo do encadeamento pós-Lançamentos —
// gerar PDF por fabricante e subir/atualizar no Drive (ver comentário no
// topo de x2-drive-lancamentos.js). Só exige 'googleapis' dentro da função
// (require tardio), então isso aqui não quebra se a dependência ainda não
// foi instalada e ninguém configurou o Drive ainda.
const driveLancamentos = require('../x2-drive-lancamentos');

// Auditoria 2026-09-30: falha de rotina, Drive ou estoque parado só ia pro
// log do console. Agora avisa por WhatsApp (best-effort, nunca lança erro;
// no máximo 1 aviso igual a cada 6 h pra não spammar).
const ALERTAS_INFO = {
  'cadeia-sync': { titulo: 'Lançamentos: cadastro falhou', acao: 'Rode "Cadastrar produtos" no painel e depois as fotos. Fotos e Drive não foram executados.' },
  'cadeia-fotos': { titulo: 'Lançamentos: fotos falharam', acao: 'Rode "Atualizar fotos" no painel e clique em "Catálogo de Produtos" quando pedir. O Drive não foi atualizado.' },
  'drive': { titulo: 'Drive: PDF não atualizado', acao: 'Confira o Drive (token OAuth) e rode: node scripts\\x2-drive-lancamentos.js --verificar' },
  'drive-sem-fabricante': { nivel: 'aviso', titulo: 'Drive: lançamentos sem fabricante', acao: 'Cadastre o fabricante desses códigos no catálogo para eles entrarem no PDF.' },
  'secao-nao-mapeada': { nivel: 'aviso', titulo: 'Lançamentos fora do catálogo', acao: 'A Seção desses códigos não está mapeada. Me envie a Seção para eu incluir.' },
  'estoque-parado': { titulo: 'Estoque/preço desatualizado', acao: 'Confira se o Painel X2 está aberto e rode "Exportar estoque".' },
  'estoque-sem': { titulo: 'Estoque nunca importado', acao: 'Rode "Exportar estoque" no Painel X2.' },
  'acao': { titulo: 'Rotina do Painel X2 falhou', acao: 'Abra o painel, veja o log da rotina e rode de novo.' },
};
const _alertasRecentes = new Map();
async function alertarFalhaX2(chave, mensagem) {
  try {
    const agora = Date.now();
    if (agora - (_alertasRecentes.get(chave) || 0) < 6 * 60 * 60 * 1000) return;
    _alertasRecentes.set(chave, agora);
    const { enviarAlertaWhatsApp, formatarAlerta } = require('../x2-whatsapp-alerta');
    try { require('../relatorio-mensal').registrarAlertaEnviado(mensagem); } catch { /* best-effort */ }
    const info = ALERTAS_INFO[chave] || ALERTAS_INFO[String(chave).split('-').slice(0, 2).join('-')] || ALERTAS_INFO[String(chave).split('-')[0]] || {};
    await enviarAlertaWhatsApp(formatarAlerta({
      nivel: info.nivel || 'erro',
      titulo: info.titulo || 'Painel X2 — atenção',
      linhas: [mensagem],
      acao: info.acao || 'Abra o Painel X2 (http://127.0.0.1:4123) e confira o log da última execução.',
    }));
  } catch (e) {
    console.error('[x2-painel] não consegui enviar alerta WhatsApp:', e.message);
  }
}
const qualidadeApenasCadastrados = require('./qualidade-apenas-cadastrados');
const { listarEntradas } = require('../../src/utils/zip-reader');
const rotinasStore = require('./rotinas');
const lancamentos = require('./lancamentos');

// dotenv — mesmo padrão do src/server.js — pra X2_USUARIO/X2_SENHA (usados
// só pelo login automático das rotinas, ver x2-fotos-scraper.js) ficarem
// disponíveis via .env local, gitignored, sem precisar exportar variável de
// ambiente manualmente toda vez que abrir o painel.
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const {
  SECOES,
  CATALOGO_DIR,
  carregarProgresso,
  fotosSuspeitas,
  LARGURA_MINIMA_AVISO,
  rodarMuitasSecoes,
  montarZipFinal,
  exportarFotosSoltas,
  // PEDIDO DO USUÁRIO (2026-09-12, drill-down de Produtos por Seção +
  // thumbnail): staging é onde a foto de verdade fica salva assim que o
  // scraper baixa, antes de virar zip (ver comentário no topo do arquivo).
  stagingSecaoDir,
} = scraper;

const FOTOS_DIR = path.join(CATALOGO_DIR, 'fotos');
const PORT = Number(process.env.X2_PAINEL_PORT || 4123);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Captura de saída (console.log/process.stdout.write) num "terminal
// virtual" simples — trata \r como "sobrescreve a linha atual", igual um
// terminal de verdade faria com a barra de progresso do scraper. ──────────
class TerminalVirtual {
  constructor() {
    this.linhas = [''];
  }
  escrever(texto) {
    for (const ch of String(texto)) {
      if (ch === '\n') {
        this.linhas.push('');
      } else if (ch === '\r') {
        this.linhas[this.linhas.length - 1] = '';
      } else {
        this.linhas[this.linhas.length - 1] += ch;
      }
    }
  }
  texto() {
    return this.linhas.join('\n');
  }
}

// ─── Estado da execução atual (só 1 ação por vez — ferramenta de uso
// solo, não precisa de fila/concorrência) ──────────────────────────────────
let execucao = null; // { tipo, terminal, rodando, aguardando: {mensagem, resolver} | null, erro }
const clientesSSE = new Set();

function transmitir() {
  if (!execucao) return;
  const payload = JSON.stringify({
    rodando: execucao.rodando,
    tipo: execucao.tipo,
    rotulo: execucao.rotulo || null,
    texto: execucao.terminal.texto(),
    aguardando: execucao.aguardando ? execucao.aguardando.mensagem : null,
    erro: execucao.erro || null,
  });
  for (const res of clientesSSE) res.write(`data: ${payload}\n\n`);
}

function confirmarFactory() {
  return (mensagem) => new Promise((resolve, reject) => {
    execucao.aguardando = { mensagem, resolver: resolve, rejeitador: reject };
    execucao.terminal.escrever(`\n⏸ Aguardando: ${mensagem}\n`);
    transmitir();
  });
}

// ⚠️ 2026-08-07: usuário relatou "sempre diz que algo já está sendo feito
// mesmo quando acabado" — causa mais provável: uma execução anterior ficou
// parada esperando confirmação humana (banner "Já cliquei, continuar", só
// visível na aba Fotos) e o usuário nunca viu/clicou nele porque estava
// noutra aba (ex: Estoque) — o `execucao.rodando` fica true PARA SEMPRE
// nesse caso, travando qualquer ação nova até reiniciar o servidor. Duas
// redes de segurança:
//   1) TIMEOUT_MAXIMO_MS abaixo: nenhuma ação roda pra sempre, mesmo que
//      trave em algum ponto sem confirmação pendente (ex: Playwright preso
//      numa página que nunca responde).
//   2) /api/cancelar (rota nova): libera a trava manualmente a qualquer
//      momento, sem precisar reiniciar o processo inteiro.
const TIMEOUT_MAXIMO_MS = 20 * 60 * 1000; // 20 minutos — generoso (rodar todas as seções de fotos pode demorar), mas finito.

function cancelarExecucaoAtual(motivo) {
  if (!execucao || !execucao.rodando) return false;
  // BUG REAL corrigido (2026-08-13, usuário relatou "mesmo com Cancelado
  // ainda está baixando fotos"): antes, essa função só rejeitava a Promise
  // de confirmação (quando havia uma pendente) OU só destravava a UI (sem
  // confirmação pendente) — nos dois casos, se o script já estava DENTRO de
  // um loop item-a-item (ex: baixando fotos de uma seção de 1751 produtos),
  // ele continuava rodando sozinho em segundo plano, só que o painel dizia
  // "Cancelado". Marcar `execucao.cancelado = true` aqui, sempre, dá aos
  // loops longos (ver `deveParar` em rodarAcao abaixo, checado a cada item
  // em x2-fotos-scraper.js/x2-catalogo-sync.js) uma forma de perguntar "o
  // usuário já cancelou?" e parar de verdade em poucos segundos.
  execucao.cancelado = true;
  if (execucao.aguardando && execucao.aguardando.rejeitador) {
    // Rejeita a Promise que `confirmar()` estava esperando — a função que
    // deu await nisso (dentro de rodarMuitasSecoes/sync.rodar/etc.) recebe
    // o erro e cai no catch/finally de rodarAcao normalmente, liberando
    // tudo do jeito certo (browser fechado etc.), não só "esquece" o estado.
    execucao.aguardando.rejeitador(new Error(motivo));
  } else {
    // Sem confirmação pendente pra rejeitar (ex: travou no meio de uma
    // chamada do Playwright que nunca resolve) — não dá pra interromper a
    // Promise em voo com segurança, então só libera a TRAVA (deixa novas
    // ações rodarem). Best-effort: a janela do Chrome da execução anterior
    // pode continuar aberta sozinha em segundo plano; fechar manualmente se
    // aparecer na barra de tarefas.
    execucao.erro = motivo;
    execucao.rodando = false;
    execucao.aguardando = null;
    transmitir();
  }
  return true;
}

// `origemRotina` (id da rotina), quando presente, marca que essa execução
// foi disparada pelo agendador (não por um clique na aba Fotos) — usado só
// pra registrar o resultado de volta na rotina (ver checarRotinas) e pra
// deixar isso visível no `execucao` transmitido por SSE.
//
// `rotulo` (pedido do usuário, 2026-09-11): nome amigável opcional pra essa
// execução ESPECÍFICA, sobrepondo o nome genérico do `tipo` na tela ("Rodando:
// ...", ver aplicarEstadoExecucao no frontend). Criado pro cadastro (tipo
// "sync") disparado automaticamente depois de Lançamentos — o usuário pediu
// que esse apareça como "Cadastro Lançamentos", só nesse caso, sem renomear
// o "Sync" comum (cadastro manual por seção, botão "Cadastrar produtos
// novos"), que continua "Sync" normalmente.
async function rodarAcao(tipo, opcoes, { origemRotina, rotulo } = {}) {
  if (execucao && execucao.rodando) {
    throw Object.assign(new Error('Já tem uma ação rodando.'), { status: 409 });
  }
  // ⚠️ 2026-08-07: até aqui só Rotinas (origemRotina) rodavam com login
  // automático — qualquer clique manual no painel (ex: "Capturar agora")
  // sempre parava esperando um humano clicar "Já cliquei, continuar",
  // mesmo já tendo confirmado (sessão 2026-08-06) que o login automático
  // via X2_USUARIO/X2_SENHA funciona de verdade. Usuário perguntou
  // diretamente por que não logava sozinho nessa sessão de testes — não
  // tinha motivo real pra manter isso manual pro tipo "painel-produtos"
  // (a trava humana existe pro fluxo de Fotos, que tem um bloqueio
  // DIFERENTE e genuíno — o popup "Catálogo de Produtos" quebrado no
  // próprio X2, não login). Agora `opcoes.automatico` (mandado pelo
  // frontend) também liga o modo automático, não só origemRotina.
  const modoAutomatico = !!origemRotina || !!opcoes.automatico;
  execucao = { tipo, terminal: new TerminalVirtual(), rodando: true, aguardando: null, erro: null, origemRotina: origemRotina || null, rotulo: rotulo || null, cancelado: false };
  transmitir();

  // PEDIDO DO USUÁRIO (2026-09-08): "quando utilizar a ferramenta Lançamentos
  // já faça a captura de foto e do produto no mesmo instante" — preenchido
  // dentro do branch `tipo === 'lancamentos-x2'` abaixo, com as Seções que
  // tiveram lançamento nessa captura (ver mapearSecoesTocadas em
  // x2-lancamentos-scraper.js). Disparado DEPOIS do `finally` (fora deste
  // try/catch), pra não segurar o lock de "Lançamentos" pelos minutos que
  // sync+baixar levam — o usuário pediu que Lançamentos continue terminando
  // rápido (só a lista) e a captura de foto/ficha rode depois, em segundo
  // plano, como uma nova execução visível na aba Rotinas.
  let slugsAutoCaptura = null;
  // PEDIDO DO USUÁRIO (2026-09-11): junto com as Seções tocadas, guarda os
  // CÓDIGOS exatos que tiveram lançamento — usados pra restringir tanto o
  // cadastro (sincronizarPorCodigos, em vez de sync.rodar por seção
  // inteira) quanto o download de fotos (codigosEspecificos em
  // calcularFila) só a esses códigos.
  let codigosAutoCaptura = null;

  // Passado pra dentro dos loops item-a-item de x2-fotos-scraper.js e
  // x2-catalogo-sync.js — ver comentário em cancelarExecucaoAtual().
  const deveParar = () => !!(execucao && execucao.cancelado);

  // Redireciona console.log/console.error/process.stdout.write pro terminal
  // virtual ENQUANTO a ação roda — os scripts originais (x2-fotos-scraper.js,
  // x2-catalogo-sync.js) não precisaram mudar uma linha de log pra isso.
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrorWrite = process.stderr.write.bind(process.stderr);
  const capturar = (texto) => {
    execucao.terminal.escrever(texto);
    transmitir();
    return true;
  };
  process.stdout.write = capturar;
  process.stderr.write = capturar;

  if (modoAutomatico) {
    execucao.terminal.escrever('▶ Rotina automática — sem clique humano: tentando login automático + abrir a tela sozinho (ver comentários em x2-fotos-scraper.js/x2-catalogo-sync.js, essa parte ainda não foi validada ao vivo).\n');
  }

  try {
    // Envolve a ação de verdade numa corrida contra TIMEOUT_MAXIMO_MS — ver
    // comentário acima de cancelarExecucaoAtual(). Promise.race não CANCELA
    // a tarefa original se o timeout vencer (JS não tem isso de verdade),
    // mas já garante que a TRAVA (`execucao.rodando`) é liberada de qualquer
    // jeito — o essencial pra não deixar o painel preso "achando" que algo
    // ainda tá rodando quando na prática já não tem mais jeito de terminar.
    const tarefa = (async () => {
      if (tipo === 'baixar') {
        await rodarMuitasSecoes(opcoes.secoes, {
          limit: opcoes.limit || null,
          channel: 'chrome',
          retrySemFoto: !!opcoes.retrySemFoto,
          // Rotina automática de fotos (sem lista de códigos) renova aos poucos as fotos
          // com mais de X2_RENOVAR_FOTOS_DIAS dias (padrão 60), até 300 por seção/execução.
          renovarAposDias: opcoes.renovarAposDias || ((origemRotina && !(opcoes.codigosEspecificos && opcoes.codigosEspecificos.length)) ? (Number(process.env.X2_RENOVAR_FOTOS_DIAS) || 60) : undefined),
          renovarLimite: opcoes.renovarLimite || undefined,
          reiniciar: !!opcoes.reiniciar,
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
          deveParar,
          // PEDIDO DO USUÁRIO (2026-09-11): quando vem do encadeamento
          // pós-Lançamentos, restringe a fila de fotos só aos códigos que
          // tiveram lançamento — ver calcularFila/codigosEspecificos em
          // x2-fotos-scraper.js. Uso manual do painel nunca manda isso
          // (fica undefined), então continua baixando a seção toda como hoje.
          codigosEspecificos: opcoes.codigosEspecificos || undefined,
        });
        // PEDIDO DO USUÁRIO (2026-08-11): "achei que quando eu clicasse em
        // atualizar fotos ele já baixasse e lançasse automaticamente no
        // sistema" — até aqui, "Montar zip" era um botão SEPARADO que
        // precisava ser clicado depois pra foto baixada virar foto
        // PUBLICADA (visível na busca do Catálogo do bot). Confuso — o
        // usuário não sabia que esse 2º passo existia. Agora "Atualizar
        // Fotos" já tenta montar o zip de cada seção selecionada logo em
        // seguida. montarZipFinal() é seguro de chamar sempre: se a seção
        // ainda não estiver 100% baixada, ela só loga um aviso e não faz
        // nada (não sobrescreve nem quebra o zip existente) — ver
        // montarZipFinal() em x2-fotos-scraper.js.
        console.log('\n▶ Publicando (montando zip) as seções que já ficaram 100% completas...');
        for (const slug of opcoes.secoes) {
          try {
            // Rodada restrita a códigos (Lançamentos): zip parcial preserva as fotos já publicadas.
            await montarZipFinal(slug, { parcial: !!(opcoes.codigosEspecificos && opcoes.codigosEspecificos.length) });
          } catch (e) {
            console.error(`Erro ao montar zip de "${slug}": ${e.message}`);
          }
        }
      } else if (tipo === 'sync') {
        if (opcoes.codigos && opcoes.codigos.length) {
          // PEDIDO DO USUÁRIO (2026-09-11): cadastro por LISTA DE CÓDIGOS
          // pontual, não por seção inteira — usado pelo encadeamento
          // automático pós-Lançamentos (ver mais abaixo), que já sabe
          // exatamente quais códigos tiveram lançamento naquela semana.
          // Mesma função já usada e testada no fluxo manual "Diff Estoque"
          // (sincronizarPorCodigos, via o wrapper rodarPorCodigos) — só
          // muda de onde vem a lista de códigos.
          await sync.rodarPorCodigos(opcoes.codigos, {
            channel: 'chrome',
            dryRun: !!opcoes.dryRun,
            confirmar: modoAutomatico ? undefined : confirmarFactory(),
            modoAutomatico,
            deveParar,
          });
        } else {
          await sync.rodar(opcoes.secoes, {
            channel: 'chrome',
            dryRun: !!opcoes.dryRun,
            semRemover: !!opcoes.semRemover,
            forcarRemocao: !!opcoes.forcarRemocao,
            confirmar: modoAutomatico ? undefined : confirmarFactory(),
            modoAutomatico,
            deveParar,
          });
        }
      } else if (tipo === 'zip') {
        for (const slug of opcoes.secoes) await montarZipFinal(slug);
      } else if (tipo === 'exportar') {
        for (const slug of opcoes.secoes) await exportarFotosSoltas(slug);
      } else if (tipo === 'estoque') {
        await estoqueExport.rodar({
          channel: 'chrome',
          estoqueOpcao: opcoes.estoqueOpcao || 'Com e sem estoque',
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
        });
      } else if (tipo === 'painel-produtos') {
        await painelProdutosSnapshot.rodar({
          channel: 'chrome',
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
        });
      } else if (tipo === 'diff-estoque') {
        // PEDIDO DO USUÁRIO (2026-08-10): "com a lista csv que eu extraio,
        // não seria mais fácil capturar códigos novos por lá e depois
        // rastreá-los com o sync" — usa o CSV de estoque (mais recente, ou
        // opcoes.caminhoCsv se um export específico foi escolhido no
        // painel) pra achar só os códigos que faltam no catálogo e buscar
        // cada um individualmente, sem escanear as 26 seções inteiras.
        // opcoes.caminhoCsv vem do painel como só o NOME do arquivo (não o
        // caminho completo) — sempre resolvido dentro de ESTOQUE_DIR, nunca
        // um caminho arbitrário mandado pelo cliente (evita path traversal).
        const caminhoCsv = opcoes.caminhoCsv
          ? path.join(estoqueExport.ESTOQUE_DIR, path.basename(opcoes.caminhoCsv))
          : null;
        await sync.rodarDiffEstoque({
          caminhoCsv,
          channel: 'chrome',
          dryRun: !!opcoes.dryRun,
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
          deveParar,
        });
      } else if (tipo === 'cortes-produtos') {
        // Alerta de estoque baixo (2026-08-10) — ver x2-cortes-produtos-scraper.js.
        // Dispara WhatsApp pro número em ALERTA_WHATSAPP_NUMERO (.env) ao
        // final, a menos que opcoes.semAlerta.
        await cortesProdutos.rodar({
          channel: 'chrome',
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
          semAlerta: !!opcoes.semAlerta,
          numeroAlerta: opcoes.numeroAlerta || undefined,
        });
      } else if (tipo === 'produtos-parados') {
        // Alerta de produtos parados (2026-08-10) — ver
        // x2-curva-abc-parados-scraper.js. Mesma lógica de disparo de
        // WhatsApp do tipo acima.
        await curvaAbcParados.rodar({
          channel: 'chrome',
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
          diasHistorico: opcoes.diasHistorico || undefined,
          semAlerta: !!opcoes.semAlerta,
          numeroAlerta: opcoes.numeroAlerta || undefined,
        });
      } else if (tipo === 'lancamentos-x2') {
        // PEDIDO DO USUÁRIO (2026-08-11): a aba Lançamentos deduzia "produto
        // novo" comparando CSVs de estoque (ver x2-painel/lancamentos.js) —
        // o usuário mandou o procedimento manual que a equipe já usa toda
        // semana e achamos a tela oficial do X2 que responde isso de
        // verdade (☰ > Compras > Catálogo de Produtos, filtro "Apenas
        // produtos com primeira entrada"). Ver x2-lancamentos-scraper.js
        // pros seletores confirmados ao vivo.
        const snapshotLancamentos = await lancamentosX2.rodar({
          channel: 'chrome',
          confirmar: modoAutomatico ? undefined : confirmarFactory(),
          modoAutomatico,
          dataInicioRecebimento: opcoes.dataInicioRecebimento || undefined,
          dataFimRecebimento: opcoes.dataFimRecebimento || undefined,
        });

        if (opcoes.semAutoCaptura) {
          console.log('\n(--semAutoCaptura: pulando cadastro+foto automático desta captura.)');
        } else if (snapshotLancamentos && snapshotLancamentos.produtos.length) {
          const { slugs, naoMapeados } = lancamentosX2.mapearSecoesTocadas(snapshotLancamentos.produtos);
          if (naoMapeados.length) {
            console.log(`\n⚠ ${naoMapeados.length} lançamento(s) com Seção não reconhecida (fica só no Excel, sem cadastro/foto automático): ${naoMapeados.map((n) => n.codigo).join(', ')}`);
            alertarFalhaX2('secao-nao-mapeada', `${naoMapeados.length} lançamento(s) com Seção não reconhecida ficaram fora do catálogo: ${naoMapeados.slice(0, 10).map((n) => n.codigo).join(', ')}`);
          }
          if (slugs.length) {
            console.log(`\n▶ ${slugs.length} Seção(ões) com lançamento novo — cadastro de ficha + fotos serão disparados automaticamente em seguida: ${slugs.join(', ')}`);
            slugsAutoCaptura = slugs;
            codigosAutoCaptura = snapshotLancamentos.produtos.map((p) => p.codigo);
          }
        }
      } else {
        throw new Error(`Ação desconhecida: ${tipo}`);
      }
    })();

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Passou de ${Math.round(TIMEOUT_MAXIMO_MS / 60000)} minutos sem terminar — travei a rede de segurança em vez de deixar "rodando" pra sempre. Se uma janela do Chrome da execução anterior ainda estiver aberta, pode fechar manualmente.`));
      }, TIMEOUT_MAXIMO_MS);
    });
    try {
      await Promise.race([tarefa, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (origemRotina) rotinasStore.registrarExecucao(origemRotina, { resultado: 'sucesso' });
  } catch (e) {
    execucao.erro = e.message;
    execucao.terminal.escrever(`\n❌ Erro: ${e.message}\n`);
    if (origemRotina) rotinasStore.registrarExecucao(origemRotina, { resultado: 'erro', erro: e.message });
    if (origemRotina || (opcoes && opcoes.automatico)) {
      alertarFalhaX2(`acao-${tipo}`, `a rotina "${rotulo || tipo}" falhou: ${String(e.message).slice(0, 300)}`);
    }
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrorWrite;
    execucao.rodando = false;
    execucao.aguardando = null;
    transmitir();
  }

  // Encadeamento automático pós-Lançamentos (ver comentário lá em cima, na
  // declaração de `slugsAutoCaptura`) — só depois do `finally`, com o lock
  // já liberado, pra virar uma execução NOVA e independente (visível na aba
  // Rotinas), não uma extensão da execução de "Lançamentos" que acabou de
  // terminar. `execucao` ainda aponta pra essa execução que acabou de
  // terminar — `execucao.cancelado` reflete se ELA foi cancelada; se foi,
  // não faz sentido continuar disparando cadastro/foto por trás.
  if (slugsAutoCaptura && slugsAutoCaptura.length && !execucao.cancelado) {
    const secoesParaAutoCaptura = slugsAutoCaptura;
    // PEDIDO DO USUÁRIO (2026-09-11): cadastro e fotos agora restritos aos
    // códigos exatos do lançamento (ver comentário na declaração de
    // codigosAutoCaptura acima) — `secoesParaAutoCaptura` continua servindo
    // só pra decidir EM QUAIS seções vale a pena procurar foto (o cadastro
    // por código já resolve sozinho a seção certa de cada produto, ver
    // sincronizarPorCodigos em x2-catalogo-sync.js).
    const codigosParaAutoCaptura = codigosAutoCaptura || [];
    console.log(`[x2-painel] Lançamentos: disparando cadastro de ficha + fotos automaticamente para ${codigosParaAutoCaptura.length} código(s): ${secoesParaAutoCaptura.join(', ')}`);
    rodarAcao('sync', { codigos: codigosParaAutoCaptura, automatico: true }, { rotulo: 'Cadastro Lançamentos' })
      .then(() => {
        // `execucao` ainda aponta pra execução do "sync" que acabou de
        // terminar (baixar só reatribui a variável quando chamado a
        // seguir) — se o usuário cancelou o cadastro de ficha, não faz
        // sentido continuar sozinho pro download de fotos.
        if (execucao && execucao.cancelado) {
          console.log('[x2-painel] cadastro de ficha cancelado — pulando download de fotos automático.');
          return null;
        }
        if (execucao && execucao.erro) {
          console.log('[x2-painel] cadastro de ficha FALHOU — pulando fotos e PDF/Drive para não subir catálogo incompleto.');
          alertarFalhaX2('cadeia-sync', `Lançamentos: o cadastro dos ${codigosParaAutoCaptura.length} código(s) novos falhou (${String(execucao.erro).slice(0, 200)}). Fotos e Drive NÃO foram executados.`);
          return null;
        }
        return rodarAcao('baixar', { secoes: secoesParaAutoCaptura, codigosEspecificos: codigosParaAutoCaptura, automatico: true }, { rotulo: 'Fotos Lançamentos' });
      })
      .then((fotosRodou) => {
        // 3º elo (PEDIDO DO USUÁRIO, 2026-09-11): "pretendo automatizar a
        // geração dos pdf e subir automaticamente para o drive" — só depois
        // que ficha (sync) E fotos terminaram, gera 1 PDF por fabricante
        // tocado e sobe/atualiza na pasta única do Drive. Não passa por
        // rodarAcao() (não é uma execução "Baixar/Sync" visível na mesma
        // aba, é upload em segundo plano) — best-effort: se GOOGLE_DRIVE_*
        // não estiver configurado ainda, só loga e segue (ver guard no
        // topo de x2-drive-lancamentos.js).
        if (fotosRodou === null) return null; // cadastro foi cancelado, nem chegou a baixar foto
        if (execucao && execucao.cancelado) {
          console.log('[x2-painel] download de fotos cancelado — pulando geração/upload de PDF automático.');
          return null;
        }
        if (execucao && execucao.erro) {
          console.log('[x2-painel] download de fotos FALHOU — pulando PDF/Drive para não subir catálogo sem as fotos novas.');
          alertarFalhaX2('cadeia-fotos', `Lançamentos: o download das fotos dos códigos novos falhou (${String(execucao.erro).slice(0, 200)}). O PDF NÃO foi enviado ao Drive.`);
          return null;
        }
        // Só os fabricantes dos códigos que entraram em Lançamentos nesta semana
        // (decisão do usuário 2026-09-30: o reenvio completo é manual, via
        // `node scripts/x2-drive-lancamentos.js --todos`, nunca automático).
        return driveLancamentos.rodarUploadDrive(codigosParaAutoCaptura).then((alvo) => {
          const erros = alvo.erros || [];
          if (erros.length) {
            const lista = erros.slice(0, 5).map((x) => `${x.fabricante || 'geral'}: ${String(x.erro).slice(0, 120)}`).join(' | ');
            alertarFalhaX2('drive', `envio de PDFs ao Drive teve ${erros.length} falha(s). ${lista}`);
          }
          if (alvo.semFabricante && alvo.semFabricante.length) {
            alertarFalhaX2('drive-sem-fabricante', `${alvo.semFabricante.length} código(s) de lançamento sem fabricante não foram ao Drive: ${alvo.semFabricante.slice(0, 10).join(', ')}`);
          }
          if (!erros.length) {
            // Resumo de sucesso da semana — best-effort.
            try {
              const { enviarAlertaWhatsApp, formatarAlerta } = require('../x2-whatsapp-alerta');
              const fabs = alvo.fabricantes || [];
              enviarAlertaWhatsApp(formatarAlerta({
                nivel: 'ok',
                titulo: 'Lançamentos da semana concluídos',
                linhas: [
                  `Produtos novos: ${codigosParaAutoCaptura.length}`,
                  `Seções atualizadas: ${secoesParaAutoCaptura.join(', ') || '—'}`,
                  `PDFs atualizados no Drive: ${fabs.length}${fabs.length ? ` (${fabs.join(', ')})` : ''}`,
                ],
              })).catch(() => {});
            } catch { /* best-effort */ }
          }
          // Export (Excel) da captura da semana, enviado ao WhatsApp de alertas
          // logo depois do resumo — independe do Drive ter dado erro ou não.
          setTimeout(() => {
            try {
              const lancDir = path.join(require('os').homedir(), '.x2-rildon-scraper', 'lancamentos-x2');
              const ultimo = fs.readdirSync(lancDir)
                .filter((f) => /^captura-.*\.xlsx$/.test(f))
                .map((f) => ({ f, t: fs.statSync(path.join(lancDir, f)).mtimeMs }))
                .sort((a, b) => b.t - a.t)[0];
              if (ultimo) {
                const periodo = ultimo.f.replace(/^captura-/, '').replace(/\.xlsx$/, '').replace('_a_', ' a ').replace(/-/g, '/');
                require('../x2-whatsapp-alerta')
                  .enviarDocumentoWhatsApp(path.join(lancDir, ultimo.f), `📋 Lançamentos da semana (${periodo})`)
                  .catch(() => {});
              }
            } catch { /* best-effort */ }
          }, 5000);
        });
      })
      .catch((e) => {
        console.error('[x2-painel] erro na captura automática de foto/ficha/PDF pós-Lançamentos:', e.message);
      });
  }
}

// ─── Status por seção — SEMPRE lido ao vivo dos mesmos arquivos que o
// painel do bot Rildon usa (ver comentário no topo do arquivo). ──────────
function contarPublicados(slug) {
  const zipPath = path.join(FOTOS_DIR, `${slug}.zip`);
  if (!fs.existsSync(zipPath)) return 0;
  try {
    const entradas = listarEntradas(zipPath);
    const codigos = new Set();
    for (const e of entradas) {
      const barra = e.name.indexOf('/');
      if (barra > 0) codigos.add(e.name.slice(0, barra));
    }
    return codigos.size;
  } catch {
    return 0;
  }
}

// Um mesmo código de produto pode aparecer em mais de uma seção (peça que
// se encaixa em duas categorias no X2 — ex.: acessorios-ferramentas +
// alternador). A soma bruta de `produtos` por seção conta essas peças 2x,
// então o total "Produtos no catálogo" precisa deduplicar por código.
function totalProdutosUnicos() {
  const codigos = new Set();
  for (const slug of Object.keys(SECOES)) {
    try {
      const produtos = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8'));
      for (const p of produtos) codigos.add(String(p.codigo).trim());
    } catch { /* json não encontrado ainda */ }
  }
  return codigos.size;
}

function statusSecoes() {
  return Object.entries(SECOES).map(([slug, label]) => {
    let produtos = 0;
    let codigosAtuais = null;
    try {
      const produtosJson = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8'));
      produtos = produtosJson.length;
      codigosAtuais = new Set(produtosJson.map((p) => String(p.codigo)));
    } catch { /* json não encontrado ainda */ }

    const progresso = carregarProgresso(slug);
    // BUG REAL corrigido (2026-09-12, investigando "Montar zip não aplica" —
    // usuário via "precisa build-zip" preso mesmo depois de rodar o build
    // com sucesso): progresso[slug].json acumula entradas de rodadas
    // passadas que não necessariamente batem 1:1 com os códigos ATUAIS do
    // catalogo.json da seção (produto reclassificado pra outra seção,
    // duplicidade de paginação já corrigida em BUZINAS, etc — daí a coluna
    // "Processados" já aparecer tipo "1517/1213", mais processado que o
    // total de produtos). Antes este bloco contava TODAS as entradas do
    // progresso.json sem checar se o código ainda pertence à seção, e
    // montarZipFinal() (x2-fotos-scraper.js) só considera os códigos do
    // catalogo.json atual — resultado: comFotoReal ficava sempre maior que
    // o que o zip real podia conter, "precisaZip" nunca virava false e o
    // badge "precisa build-zip" ficava preso pra sempre, mesmo com o build
    // rodando certinho. Fix: só conta progresso de códigos que ainda estão
    // no catalogo.json da seção, igual o filtro que montarZipFinal já usa.
    const entradas = codigosAtuais
      ? Object.entries(progresso).filter(([codigo]) => codigosAtuais.has(codigo)).map(([, v]) => v)
      : Object.values(progresso);
    const baixados = entradas.length;
    const comFotoReal = entradas.filter((e) => e.status === 'ok').length;
    // PEDIDO DO USUÁRIO (2026-09-12, "vamos fazer mudanças de ui e ux"):
    // antes não tinha nenhum jeito de ver, seção por seção, quantos itens
    // ficaram com status "erro" sem rodar o log bruto de uma execução —
    // foi assim que os 1209 erros de MECÂNICA (69%!) só foram percebidos
    // numa sessão de teste ao vivo, bem depois. Agora vira coluna/badge/
    // filtro na tabela de Seções (ver index.html/app.js).
    const erros = entradas.filter((e) => e.status === 'erro').length;
    const pequenas = entradas.filter((e) => fotosSuspeitas(e.detalhes).length > 0).length;
    const publicados = contarPublicados(slug);

    return {
      slug,
      label,
      produtos,
      baixados,
      comFotoReal,
      erros,
      pequenas,
      publicados,
      // "Publicado" (visível no Catálogo do painel do bot) só bate com
      // "baixado" DEPOIS de rodar --build-zip — ver comentário no topo.
      precisaZip: comFotoReal > publicados,
    };
  });
}

// ─── Rotas ─────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    secoes: statusSecoes(),
    totalProdutosUnicos: totalProdutosUnicos(),
    limiteRemocaoSuspeitaPct: Math.round((sync.LIMITE_REMOCAO_SUSPEITA || 0.3) * 100),
    larguraMinimaAviso: LARGURA_MINIMA_AVISO,
    execucao: execucao ? {
      tipo: execucao.tipo,
      rodando: execucao.rodando,
      aguardando: execucao.aguardando ? execucao.aguardando.mensagem : null,
      texto: execucao.terminal.texto(),
      erro: execucao.erro,
    } : null,
  });
});

// ─── Produtos por Seção — drill-down (2026-09-12, mockup "CatálogoPro") ──
// Pedido do usuário: em vez de listar 19 mil produtos soltos, a tabela de
// Produtos só aparece ao clicar numa Seção específica — carrega só os
// produtos DAQUELA seção (no máximo ~3.000, seção MOTOR DE PARTIDA, a
// maior). Mistura o `<slug>.json` (dado de catálogo: código/nome/linha)
// com o checkpoint de progresso do scraper (status: ok/sem_foto/
// placeholder/erro/pendente — "pendente" é código que ainda nem foi
// tentado) — mesmas duas fontes que statusSecoes() já lê, só que por
// produto em vez de agregado.
function _extensaoImagem(nome) {
  const ext = path.extname(String(nome || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

app.get('/api/secoes/:slug/produtos', (req, res) => {
  const { slug } = req.params;
  const label = SECOES[slug];
  if (!label) return res.status(404).json({ error: 'Seção não encontrada.' });

  let produtosJson = [];
  try {
    produtosJson = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8'));
  } catch { /* json não encontrado ainda — seção sem extração (ex: consumo) */ }

  const progresso = carregarProgresso(slug);
  const produtos = produtosJson.map((p) => {
    const st = progresso[String(p.codigo)];
    return {
      codigo: p.codigo,
      nome: p.nome,
      linha: p.linha || null,
      // "pendente" = ainda não passou pelo scraper nenhuma vez (não confundir
      // com "sem_foto" — esse já foi tentado e o X2 não tinha foto real).
      status: st ? st.status : 'pendente',
      temThumb: !!(st && st.status === 'ok' && st.arquivos && st.arquivos.length),
      // PEDIDO DO USUÁRIO (2026-09-12, redesign modal): contagem real de
      // arquivos baixados por produto (não é "X de Y esperado" — não temos
      // esse total do X2, só o que foi de fato baixado) + se alguma dessas
      // fotos está abaixo de LARGURA_MINIMA_AVISO (mesma função já usada
      // no agregado por seção, aqui aplicada por produto).
      numFotos: st && st.arquivos ? st.arquivos.length : 0,
      fotoSuspeita: !!(st && fotosSuspeitas(st.detalhes).length > 0),
    };
  });

  res.json({ slug, label, produtos });
});

app.get('/api/secoes/:slug/produtos/:codigo/thumb', (req, res) => {
  const { slug, codigo } = req.params;
  if (!SECOES[slug]) return res.status(404).end();
  const progresso = carregarProgresso(slug);
  const st = progresso[codigo];
  const nomeArquivo = st && st.arquivos && st.arquivos[0];
  if (!nomeArquivo) return res.status(404).end();
  const caminho = path.join(stagingSecaoDir(slug), codigo, nomeArquivo);
  const mime = _extensaoImagem(nomeArquivo);
  if (!mime || !fs.existsSync(caminho)) return res.status(404).end();
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(caminho).pipe(res);
});

// ─── Busca global de produtos (2026-09-12, mockup "CatálogoPro") — varre
// os JSONs das 27 seções (mesmo padrão de totalProdutosUnicos()) por código
// OU nome, sem precisar abrir a Seção primeiro. Cap de 30 resultados: é
// busca de "achar rápido", não relatório — se vier muita coisa, a pessoa
// afina o termo.
app.get('/api/produtos/buscar', (req, res) => {
  const termoBruto = String(req.query.q || '').trim();
  if (termoBruto.length < 2) return res.json({ resultados: [] });
  const termo = termoBruto.toLowerCase();

  const resultados = [];
  for (const [slug, label] of Object.entries(SECOES)) {
    if (resultados.length >= 30) break;
    let produtosJson;
    try {
      produtosJson = JSON.parse(fs.readFileSync(path.join(CATALOGO_DIR, `${slug}.json`), 'utf8'));
    } catch { continue; }
    for (const p of produtosJson) {
      if (resultados.length >= 30) break;
      const bateCodigo = String(p.codigo).toLowerCase().includes(termo);
      const bateNome = String(p.nome || '').toLowerCase().includes(termo);
      if (bateCodigo || bateNome) {
        resultados.push({ codigo: p.codigo, nome: p.nome, secaoSlug: slug, secaoLabel: label });
      }
    }
  }
  res.json({ resultados });
});

// ─── Estoque (2026-08-06) — só lista/serve os CSVs já baixados por
// x2-estoque-export.js; nenhum parsing/estrutura ainda (decisão do
// usuário: "só baixar e guardar o arquivo por enquanto").
app.get('/api/estoque/exports', (req, res) => {
  res.json({ exports: estoqueExport.carregarExports() });
});
app.use('/estoque-files', express.static(estoqueExport.ESTOQUE_DIR));

// ─── Painel de Produtos (snapshot) — mesma lógica de "só guardar por
// enquanto" do Estoque, ver x2-painel-produtos-snapshot.js.
app.get('/api/painel-produtos/historico', (req, res) => {
  res.json({ historico: painelProdutosSnapshot.carregarHistorico() });
});

// ─── Alertas de WhatsApp (2026-08-10) — Cortes de Produtos (estoque baixo,
// diário) e Curva ABC Produtos Parados (sem venda, semanal). Cada rota só
// serve a última captura salva em disco (mesmo padrão de Estoque/Painel de
// Produtos) — o disparo em si acontece no fim de `rodar()` de cada script
// (ver x2-cortes-produtos-scraper.js / x2-curva-abc-parados-scraper.js),
// não aqui.
app.get('/api/alertas/cortes-produtos/ultima-captura', (req, res) => {
  const captura = cortesProdutos.carregarUltimaCaptura();
  if (!captura) return res.status(404).json({ error: 'Nenhuma captura ainda — rode "Rodar agora" na rotina de Cortes de Produtos primeiro.' });
  res.json(captura);
});
app.get('/api/alertas/cortes-produtos/historico', (req, res) => {
  res.json({ historico: cortesProdutos.carregarHistorico() });
});
app.get('/api/alertas/produtos-parados/ultima-captura', (req, res) => {
  const captura = curvaAbcParados.carregarUltimaCaptura();
  if (!captura) return res.status(404).json({ error: 'Nenhuma captura ainda — rode "Rodar agora" na rotina de Produtos Parados primeiro.' });
  res.json(captura);
});
app.get('/api/alertas/produtos-parados/historico', (req, res) => {
  res.json({ historico: curvaAbcParados.carregarHistorico() });
});

// ─── Lançamentos via X2 (2026-08-11) — ver x2-lancamentos-scraper.js.
// Mesmo padrão de "só serve a última captura salva" dos alertas acima; o
// disparo em si acontece via /api/acao (tipo "lancamentos-x2").
app.get('/api/lancamentos-x2/ultima-captura', (req, res) => {
  const captura = lancamentosX2.carregarUltimaCaptura();
  if (!captura) return res.status(404).json({ error: 'Nenhuma captura ainda — clique em "Buscar lançamentos no X2" primeiro.' });
  res.json(captura);
});

// PEDIDO DO USUÁRIO (2026-08-11): "a ideia é pegar esses lançamentos e gerar
// um arquivo... pra ficar guardado pra utilizar quando necessário" — cada
// captura já salva uma planilha irmã do .json (ver salvarCaptura em
// x2-lancamentos-scraper.js); aqui só listamos esses arquivos, mesmo padrão
// de /api/estoque/exports.
app.get('/api/lancamentos-x2/exports', (req, res) => {
  res.json({ exports: lancamentosX2.carregarExports() });
});

// ⚠️ Corrigido 2026-08-11 (passou por 3 formatos: CSV cru, CSV com célula de
// período, agora .xlsx de verdade) — baixar o arquivo estático (servido
// direto do disco) travava o download no formato de quando aquela captura
// foi salva; se o formato mudasse depois, capturas antigas continuavam
// baixando desatualizadas pra sempre, mesmo reiniciando o servidor. Agora
// gera a planilha NA HORA a partir do .json (fonte de verdade) com
// produtosParaXlsxBuffer() atual, então nunca fica desatualizado de novo.
// PEDIDO DO USUÁRIO (2026-08-11): "consegue padronizar sempre assim" —
// mandou o .csv aberto e resalvo como .xlsx no Excel (célula de período
// MESCLADA A1:B1 + larguras de coluna ajustadas). Célula mesclada não existe
// em CSV puro — só dá pra fazer gerando um .xlsx de verdade (lib exceljs).
app.get('/api/lancamentos-x2/xlsx/:nomeBase', async (req, res) => {
  const { nomeBase } = req.params;
  if (!/^captura-\d{2}-\d{2}-\d{4}_a_\d{2}-\d{2}-\d{4}$/.test(nomeBase)) {
    return res.status(400).json({ error: 'Nome de captura inválido.' });
  }
  const snapshot = lancamentosX2.carregarCapturaPorNomeBase(nomeBase);
  if (!snapshot) return res.status(404).json({ error: 'Captura não encontrada.' });
  try {
    const buffer = await lancamentosX2.produtosParaXlsxBuffer(snapshot.produtos, snapshot.periodoRecebimento);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeBase}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// PEDIDO DO USUÁRIO (2026-09-22): reenviar manualmente TODOS os catálogos
// "- Mecânica" ao Drive — depois de corrigir o bug que fazia esses PDFs
// saírem no estilo elétrica (ver Issue/PR de hoje sobre
// _estiloCatalogoCompleto), os arquivos já subidos antes do fix ficaram
// com o layout errado na pasta do Drive; precisam ser gerados/enviados de
// novo com o estilo certo. Ação rápida SEM passar por rodarAcao()/SSE — só
// chama o bot e o Drive, não abre Chrome nem mexe no X2 (mesmo espírito de
// "leve" do reenvio automático pós-Lançamentos), então um JSON síncrono já
// basta, sem precisar da aba "Execução". Ver
// x2-drive-lancamentos.js/rodarUploadTodosMecanica().
app.post('/api/drive/reenviar-mecanica', async (req, res) => {
  try {
    const resultado = await driveLancamentos.rodarUploadTodosMecanica();
    if (!resultado.enviados.length && !resultado.erros.length && !resultado.fabricantes.length) {
      // config ausente (API_TOKEN/OAuth/pasta) — rodarUploadTodosMecanica já
      // logou o motivo específico no console do servidor.
      return res.status(400).json({ error: 'Upload pro Drive não está configurado — confira o .env (ver console do servidor pro motivo exato).' });
    }
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: `Erro ao reenviar catálogos Mecânica ao Drive: ${e.message}` });
  }
});

// ─── Qualidade cadastral (2026-08-07) — listas de Itens Inativos, Sem
// Foto/Arquivo, Preço de Venda Zerado, Sem Custo Médio. Capturadas junto
// com o snapshot normal (tipo "painel-produtos", ver rodarAcao acima);
// aqui só servimos a última captura salva em disco.
// "Apenas Cadastrados" (2026-08-07) — 5ª categoria, mas de origem diferente
// das outras 4: não vem de captura no navegador, é calculada na hora a
// partir do CSV de estoque mais recente já baixado (ver comentário em
// qualidade-apenas-cadastrados.js). Por isso entra na lista de `tipos` mas
// tem tratamento à parte na rota de dados abaixo.
app.get('/api/painel-produtos/qualidade-cadastral', (req, res) => {
  res.json({
    tipos: [
      ...painelProdutosSnapshot.DIVERGENCIAS_LISTAVEIS,
      { chave: qualidadeApenasCadastrados.CHAVE, labelBadge: qualidadeApenasCadastrados.LABEL_BADGE },
    ],
  });
});
app.get('/api/painel-produtos/qualidade-cadastral/:chave', (req, res) => {
  if (req.params.chave === qualidadeApenasCadastrados.CHAVE) {
    const lista = qualidadeApenasCadastrados.calcularApenasCadastrados();
    if (!lista) {
      return res.status(404).json({ error: 'Nenhum CSV de estoque baixado ainda — vá na aba Estoque e clique em "Baixar CSV agora" primeiro (opção "Com e sem estoque" traz o dado completo).' });
    }
    return res.json(lista);
  }
  const lista = painelProdutosSnapshot.carregarListaQualidade(req.params.chave);
  if (!lista) {
    return res.status(404).json({ error: 'Nenhuma captura ainda pra esse tipo — rode "Capturar agora" (ou a rotina Snapshot Painel de Produtos) primeiro.' });
  }
  res.json(lista);
});

// ─── TEMPORÁRIO (2026-08-07, sessão de debug) — serve o diagnóstico salvo
// quando abrirPainelProdutos() falha achar a aba "Painel". Remover depois
// que o bug de navegação for corrigido e confirmado.
app.get('/api/debug/painel-produtos-falha.json', (req, res) => {
  const p = require('path').join(painelProdutosSnapshot.QUALIDADE_DIR, '..', 'debug-ultima-falha.json');
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: 'sem diagnóstico salvo ainda' });
  res.sendFile(p);
});
app.get('/api/debug/painel-produtos-falha.png', (req, res) => {
  const p = require('path').join(painelProdutosSnapshot.QUALIDADE_DIR, '..', 'debug-ultima-falha.png');
  if (!require('fs').existsSync(p)) return res.status(404).send('sem screenshot ainda');
  res.sendFile(p);
});
// Dispara a investigação pontual do botão "Imprimir Itens" (não clica nele,
// só reporta atributos — ver comentário em investigarBotaoImprimir).
app.post('/api/debug/investigar-imprimir', (req, res) => {
  if (execucao && execucao.rodando) {
    return res.status(409).json({ error: 'Já tem uma ação rodando.' });
  }
  execucao = { tipo: 'investigar-imprimir', terminal: new TerminalVirtual(), rodando: true, aguardando: null, erro: null };
  transmitir();
  const origWrite = process.stdout.write.bind(process.stdout);
  const capturar = (texto) => { execucao.terminal.escrever(texto); transmitir(); return true; };
  process.stdout.write = capturar;
  painelProdutosSnapshot.investigarBotaoImprimir({ channel: 'chrome' })
    .catch((e) => { execucao.erro = e.message; console.error('Erro:', e.message); })
    .finally(() => { process.stdout.write = origWrite; execucao.rodando = false; transmitir(); });
  res.status(202).json({ ok: true });
});
// Genérico — serve qualquer debug-<sufixo>.json/.png salvo em
// PAINEL_PRODUTOS_DIR (ex: debug-sem-metricas.json).
app.get('/api/debug/:arquivo', (req, res) => {
  const nome = req.params.arquivo;
  if (!/^debug-[a-zA-Z0-9-]+\.(json|png)$/.test(nome)) return res.status(400).json({ error: 'nome inválido' });
  const p = require('path').join(painelProdutosSnapshot.QUALIDADE_DIR, '..', nome);
  if (!require('fs').existsSync(p)) return res.status(404).json({ error: 'sem diagnóstico salvo ainda' });
  res.sendFile(p);
});

// ─── Lançamentos (2026-08-07) — produtos novos detectados por diff entre
// snapshots do CSV de estoque já baixados (ver scripts/x2-painel/
// lancamentos.js). 100% arquivo local, não toca em banco nenhum.
app.get('/api/lancamentos', (req, res) => {
  const { desde, ate } = req.query;
  try {
    res.json(lancamentos.listarLancamentos({ desde, ate }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/log-stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');
  clientesSSE.add(res);
  req.on('close', () => clientesSSE.delete(res));
});

app.post('/api/acao', (req, res) => {
  const { tipo, secoes, opcoes } = req.body || {};
  // "estoque"/"painel-produtos"/"diff-estoque"/"cortes-produtos"/
  // "produtos-parados" não usam secoes (capturam/exportam/alertam tudo de
  // uma vez — ver x2-estoque-export.js / x2-painel-produtos-snapshot.js /
  // x2-cortes-produtos-scraper.js / x2-curva-abc-parados-scraper.js) — as
  // outras ações continuam exigindo pelo menos 1 seção selecionada. Mesma
  // lista de scripts/x2-painel/rotinas.js (TIPOS_SEM_SECOES) — duplicada de
  // propósito aqui porque esta rota valida requisições AVULSAS do painel
  // (clique em "Rodar agora"), não uma Rotina agendada.
  const TIPOS_SEM_SECOES = rotinasStore.TIPOS_SEM_SECOES;
  if (!tipo) {
    return res.status(400).json({ error: 'tipo é obrigatório.' });
  }
  if (!TIPOS_SEM_SECOES.includes(tipo) && (!Array.isArray(secoes) || !secoes.length)) {
    return res.status(400).json({ error: 'secoes (array não vazio) é obrigatório pra essa ação.' });
  }
  const desconhecidas = (secoes || []).filter((s) => !SECOES[s]);
  if (desconhecidas.length) {
    return res.status(400).json({ error: `Seção(ões) desconhecida(s): ${desconhecidas.join(', ')}` });
  }
  // Checagem SÍNCRONA aqui (não só dentro de rodarAcao) — sem isso, dois
  // cliques em sequência rápida (ex: duplo-clique sem querer) recebiam
  // "ok:true" os dois, mesmo o segundo sendo rejeitado por trás sem o
  // cliente saber (rodarAcao é async, o throw dela vira uma Promise
  // rejeitada, não chega antes do res.status(202) já ter sido enviado).
  if (execucao && execucao.rodando) {
    return res.status(409).json({ error: 'Já tem uma ação rodando.' });
  }

  rodarAcao(tipo, { ...opcoes, secoes }).catch((e) => {
    console.error(`[x2-painel] erro não tratado na ação ${tipo}:`, e.message);
  });

  res.status(202).json({ ok: true });
});

app.post('/api/confirmar', (req, res) => {
  if (!execucao || !execucao.aguardando) {
    return res.status(409).json({ error: 'Nada aguardando confirmação agora.' });
  }
  const { resolver } = execucao.aguardando;
  execucao.aguardando = null;
  execucao.terminal.escrever('\n▶ Confirmado, continuando...\n');
  transmitir();
  resolver();
  res.json({ ok: true });
});

// 2026-08-07 — ver comentário em cancelarExecucaoAtual(). Libera a trava
// "já tem uma ação rodando" manualmente, sem precisar reiniciar o servidor.
app.post('/api/cancelar', (req, res) => {
  const cancelou = cancelarExecucaoAtual('Cancelado manualmente pelo usuário.');
  if (!cancelou) {
    return res.status(409).json({ error: 'Nada rodando pra cancelar agora.' });
  }
  res.json({ ok: true });
});

// ─── Rotinas (2026-08-06) ──────────────────────────────────────────────
// CRUD fino em cima de scripts/x2-painel/rotinas.js (armazenamento puro) +
// o agendador de verdade (checarRotinas, chamado a cada minuto lá embaixo).

app.get('/api/rotinas', (req, res) => {
  const agora = new Date();
  const lista = rotinasStore.carregarRotinas().map((r) => ({
    ...r,
    proximaExecucao: r.ativa ? rotinasStore.proximaExecucao(r, agora).toISOString() : null,
  }));
  res.json({ rotinas: lista, temCredenciais: !!(process.env.X2_USUARIO && process.env.X2_SENHA) });
});

app.post('/api/rotinas', (req, res) => {
  try {
    const criada = rotinasStore.criarRotina(req.body || {});
    res.status(201).json(criada);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.patch('/api/rotinas/:id', (req, res) => {
  try {
    const atualizada = rotinasStore.atualizarRotina(req.params.id, req.body || {});
    res.json(atualizada);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/rotinas/:id', (req, res) => {
  try {
    rotinasStore.removerRotina(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Dispara a rotina AGORA, fora do horário agendado — pensado pra testar uma
// rotina nova (ver se o login automático/navegação direta funcionam mesmo)
// sem precisar esperar até de madrugada pra descobrir que não funcionou.
app.post('/api/rotinas/:id/rodar-agora', (req, res) => {
  const lista = rotinasStore.carregarRotinas();
  const rotina = lista.find((r) => r.id === req.params.id);
  if (!rotina) return res.status(404).json({ error: 'Rotina não encontrada.' });
  if (execucao && execucao.rodando) {
    return res.status(409).json({ error: 'Já tem uma ação rodando.' });
  }
  rodarAcao(rotina.tipo, { ...rotina.opcoes, secoes: rotina.secoes }, { origemRotina: rotina.id }).catch((e) => {
    console.error(`[x2-painel] erro não tratado na rotina ${rotina.nome}:`, e.message);
  });
  res.status(202).json({ ok: true });
});

// Checagem do agendador — roda a cada minuto (ver setInterval abaixo). Só
// dispara 1 rotina por vez (reusa o mesmo lock de `execucao` das ações
// manuais — ferramenta de uso solo, não faz sentido rodar 2 coisas juntas);
// se mais de uma rotina "vencer" no mesmo minuto, as outras esperam a
// próxima checagem (1 min depois, inofensivo pra esse tipo de tarefa).
function checarRotinas() {
  if (execucao && execucao.rodando) return;
  const agora = new Date();
  const pendente = rotinasStore.carregarRotinas().find((r) => rotinasStore.deveRodarAgora(r, agora));
  if (!pendente) return;
  // PEDIDO DO USUÁRIO (2026-09-11): rotina "a cada N horas" não tem
  // `horario` (fica null, ver rotinas.js) — log deixa claro qual dos dois
  // modelos de agendamento venceu.
  const quandoVenceu = pendente.frequencia === 'horas' ? `a cada ${pendente.intervaloHoras}h` : pendente.horario;
  console.log(`[x2-painel] rotina "${pendente.nome}" venceu (${quandoVenceu}) — disparando automaticamente...`);
  rodarAcao(pendente.tipo, { ...pendente.opcoes, secoes: pendente.secoes }, { origemRotina: pendente.id }).catch((e) => {
    console.error(`[x2-painel] erro não tratado na rotina ${pendente.nome}:`, e.message);
  });
}

const server = http.createServer(app);
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nPainel Fotos X2 rodando em ${url}`);
  console.log('(só acessível nesta máquina — não exposto na rede)\n');

  // Abre o navegador sozinho — evita o usuário ter que copiar/colar a URL,
  // e evita corrida entre o .bat e o servidor ainda não estar de pé (o bat
  // só dispara "start" DEPOIS que o servidor já confirmou que está ouvindo).
  if (process.platform === 'win32') {
    require('child_process').exec(`start "" "${url}"`, () => {});
  }

  // Agendador de Rotinas (2026-08-06) — checa a cada minuto se alguma rotina
  // "venceu". SÓ funciona enquanto este servidor estiver aberto (ligar o
  // painel de manhã e fechar à noite não roda rotina nenhuma durante a
  // madrugada) — isso é uma limitação real, não escondida: pra rotina
  // noturna valer a pena, o processo precisa continuar rodando (deixar a
  // janela minimizada, por exemplo), não só ser aberto uma vez.
  setInterval(checarRotinas, 60 * 1000);
  checarRotinas();

  // Relatório mensal em PDF por WhatsApp (pedido 2026-09-30): último dia do
  // mês às 20h (ou dia 1º às 8h se o painel estava fechado). Ver
  // scripts/relatorio-mensal.js. Checa a cada 15 min; 1 envio por mês.
  const relatorioMensal = require('../relatorio-mensal');
  setInterval(() => relatorioMensal.verificarEEnviarSeDevido(), 15 * 60 * 1000);
  setTimeout(() => relatorioMensal.verificarEEnviarSeDevido(), 60 * 1000);

  // Vigia de estoque parado (auditoria 2026-09-30): se o CSV que alimenta
  // preço/estoque do bot tem mais de 12 h, avisa por WhatsApp (1x a cada 6 h).
  const CSV_ESTOQUE = path.join(__dirname, '..', '..', 'src', 'data', 'estoque-latest.csv');
  setInterval(() => {
    try {
      const idadeH = (Date.now() - fs.statSync(CSV_ESTOQUE).mtimeMs) / 3600000;
      if (idadeH > 12) alertarFalhaX2('estoque-parado', `o estoque/preço do bot não atualiza há ${Math.round(idadeH)} h (rotina de 5 h parada?). Confira se o Painel X2 está aberto.`);
    } catch {
      alertarFalhaX2('estoque-sem-csv', 'não achei src/data/estoque-latest.csv — estoque/preço nunca foi importado nesta máquina.');
    }
  }, 30 * 60 * 1000);
});
