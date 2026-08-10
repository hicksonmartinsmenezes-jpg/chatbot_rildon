#!/usr/bin/env node
/**
 * scripts/x2-whatsapp-alerta.js
 *
 * PEDIDO DO USUÁRIO (2026-08-10): "minha ideia, é o bot poder alertar isso"
 * — depois de escopar os alertas de Cortes de Produtos (estoque baixo) e
 * Curva ABC produtos parados, o último passo é a rotina do Painel X2
 * (processo separado, roda no HOST fora do Docker — mesma arquitetura de
 * x2-estoque-export.js) disparar uma mensagem de WhatsApp de verdade através
 * do bot Rildon (processo DENTRO do container Docker, dono da conexão
 * Baileys ativa).
 *
 * ─── Por que HTTP e não `docker exec` (like o pipeline de Estoque) ────────
 * `x2-estoque-export.js` dispara `docker exec chatbot_rildon_app npm run
 * importar-estoque` porque IMPORTAR não depende de conexão nenhuma — é só
 * ler um CSV e gravar no Postgres, roda igual em qualquer processo Node
 * novo. ENVIAR WhatsApp é diferente: `sendMessage()` (src/config/whatsapp.js)
 * só funciona dentro do processo que já tem `conn.sock` — o socket Baileys
 * vivo, resultado de meses de sessão pareada. Rodar `docker exec ... node
 * algum-script.js` criaria um processo NOVO sem esse socket. Por isso aqui
 * chama a API HTTP do bot Rildon (`POST /api/messages/send`, já existe e já
 * é usada pelo painel de atendimento pra mandar mensagem manual) — esse
 * endpoint roda DENTRO do processo certo, o único lugar onde o socket existe.
 *
 * ─── Autenticação: API_TOKEN, já existente no projeto ─────────────────────
 * `src/routes/auth.routes.js` (`authSession`) já aceita um Bearer token
 * igual a `process.env.API_TOKEN` como atalho pra "Integração API" — usuário
 * sintético com perfil "api", que `access-control.js` já trata como
 * privilegiado (`isPrivileged`). Isso significa que `POST /api/messages/send`
 * com esse header PULA a checagem de "atendente só manda mensagem em
 * conversa que já atende" (`canUserAccessConversation`) — funciona mesmo
 * pra um número de teste sem ticket nenhum ainda. Não foi criado nada novo
 * no bot Rildon pra isso — API_TOKEN já estava configurado no .env
 * (confirmado: 64 caracteres, não é mais o placeholder).
 *
 * ─── Onde o bot roda ────────────────────────────────────────────────────
 * `docker-compose.yml` publica a porta do container (`PORT` no .env, 3000
 * por padrão) pro host — por isso `http://localhost:${PORT}` funciona
 * chamado de um processo rodando no HOST (Windows), mesmo o bot estando
 * dentro do Docker.
 *
 * ─── userId aceita número puro ─────────────────────────────────────────
 * `sendMessage()` normaliza via `resolveSendJid`/`normalizeJid`
 * (`src/whatsapp/lid-map.js`): qualquer string que não termine em
 * "@s.whatsapp.net"/"@lid"/"@g.us" vira `${dígitos}@s.whatsapp.net`. Não
 * precisa montar o JID aqui — só mandar os dígitos com DDI.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = `http://localhost:${PORT}`;

/** Manda uma mensagem de texto via bot Rildon (WhatsApp real) pro número
 * informado (ou `process.env.ALERTA_WHATSAPP_NUMERO` se `numero` não vier).
 * Aceita número em qualquer formato (com/sem "+", espaço, traço) — só os
 * dígitos importam pro backend. Lança erro com mensagem clara se o bot não
 * estiver rodando, não estiver autenticado no WhatsApp, ou faltar
 * configuração (API_TOKEN/ALERTA_WHATSAPP_NUMERO). */
async function enviarAlertaWhatsApp(mensagem, { numero } = {}) {
  const apiToken = process.env.API_TOKEN;
  if (!apiToken || apiToken === 'troque_por_um_token_com_64_caracteres_ou_mais') {
    throw new Error('API_TOKEN não configurado no .env (ou ainda é o valor de exemplo) — sem isso não dá pra autenticar com o bot Rildon pra mandar o alerta.');
  }
  const destino = numero || process.env.ALERTA_WHATSAPP_NUMERO;
  if (!destino) {
    throw new Error('Nenhum número de destino: informe { numero } ou configure ALERTA_WHATSAPP_NUMERO no .env.');
  }

  let resposta;
  try {
    resposta = await fetch(`${BASE_URL}/api/messages/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ userId: destino, message: mensagem }),
    });
  } catch (e) {
    throw new Error(`Não consegui chamar o bot Rildon em ${BASE_URL} — ele está rodando (docker compose up)? Detalhe: ${e.message}`);
  }

  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    throw new Error(`Bot Rildon recusou o envio (HTTP ${resposta.status}): ${corpo.error || 'sem detalhe.'}`);
  }
  return corpo;
}

module.exports = { enviarAlertaWhatsApp, BASE_URL };
