#!/usr/bin/env node
/**
 * scripts/x2-perfil-chrome.js
 *
 * MOTIVO (2026-10-14, diagnóstico ao vivo no servidor): fotos, estoque,
 * catálogo e painel-produtos usavam TODOS o mesmo perfil persistente do
 * Chrome (`~/.x2-rildon-scraper/chrome-profile`). O Chrome não aceita duas
 * instâncias no mesmo perfil, então quando duas tarefas rodavam juntas a
 * segunda morria com:
 *
 *   browserType.launchPersistentContext: Target page, context or browser
 *   has been closed
 *
 * Foi exatamente isso que manteve a rotina "Atualização de Estoque/Preço"
 * falhando enquanto a captura de fotos rodava — o estoque do bot ficou
 * parado em 13/10 11:55 enquanto a captura ocupava o perfil.
 *
 * Agora cada tipo de tarefa tem o SEU perfil. Para não obrigar ninguém a
 * logar de novo em cada um, na primeira vez que um perfil novo é pedido ele
 * é semeado com uma cópia do perfil antigo (`chrome-profile`), se existir —
 * assim a sessão do X2 já salva continua valendo.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const WORK_DIR = path.join(os.homedir(), '.x2-rildon-scraper');
const PERFIL_LEGADO = path.join(WORK_DIR, 'chrome-profile');

/**
 * Devolve (criando se precisar) a pasta de perfil do Chrome para um tipo de
 * tarefa. `nome` é um sufixo curto: 'fotos', 'estoque', 'catalogo',
 * 'painel-produtos'.
 */
function perfilChrome(nome) {
  if (!nome || !/^[a-z0-9-]+$/.test(nome)) {
    throw new Error(`perfilChrome: nome de perfil inválido: ${nome}`);
  }
  const destino = path.join(WORK_DIR, `chrome-profile-${nome}`);

  if (!fs.existsSync(destino)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    // Semeia com o perfil antigo para não perder o login já salvo do X2.
    // Se a cópia falhar por qualquer motivo (perfil em uso, arquivo
    // travado), segue com um perfil vazio — o login automático via
    // X2_USUARIO/X2_SENHA resolve; perder a sessão salva é um incômodo,
    // não um erro que deva derrubar a execução.
    if (fs.existsSync(PERFIL_LEGADO)) {
      try {
        fs.cpSync(PERFIL_LEGADO, destino, { recursive: true, force: false, errorOnExist: false });
        console.log(`[perfil-chrome] perfil "${nome}" criado a partir do perfil antigo (login do X2 preservado).`);
      } catch (e) {
        console.log(`[perfil-chrome] não deu para copiar o perfil antigo para "${nome}" (${e.message}); começando um perfil novo — o login automático cuida disso.`);
      }
    }
    fs.mkdirSync(destino, { recursive: true });
  }

  return destino;
}

module.exports = { WORK_DIR, PERFIL_LEGADO, perfilChrome };
