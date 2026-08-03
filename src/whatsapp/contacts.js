// contacts.js — Auto-registro de contatos a partir de mensagens do WhatsApp.
//
// Extraído de src/config/whatsapp.js (arquivo estava com 747 linhas) para
// reduzir o tamanho do módulo de conexão, seguindo o mesmo padrão já usado
// para lid-map.js e message-utils.js. Nenhuma mudança de comportamento —
// mesma função, movida para cá.

const logger        = require("../utils/logger");
const pool          = require("../database/postgres");
const { emitEvent } = require("../services/socket.service");
const { resolveJidToLid, getProfilePhotoCandidates } = require("./lid-map");

async function autoRegisterContact(userId, contactName = "") {
  const rawUserId = String(userId || "").trim();
  const isPhoneJid = rawUserId.endsWith("@s.whatsapp.net");
  const isLidJid = rawUserId.endsWith("@lid");
  if (!isPhoneJid && !isLidJid) return null;

  // Para @lid sem resolução, salvamos o identificador numérico do LID.
  // Isso evita perda de rastreio no painel até que o mapa LID→JID seja descoberto.
  const phone = rawUserId.replace(/@(s\.whatsapp\.net|lid)$/i, "").replace(/\D/g, "");
  if (!phone) return null;

  const safeName = String(contactName || "").trim() || phone;

  // BUG CORRIGIDO: quando este cliente chegou antes via "@lid" SEM
  // resolução (LID_FALLBACK em src/config/whatsapp.js), salvamos ali o
  // identificador NUMÉRICO do próprio lid como telefone provisório — não é
  // o número real. Quando o mesmo cliente resolve depois (mensagem nova já
  // chega como "@s.whatsapp.net", ou o mapa lid→jid é aprendido via
  // sincronização de contatos), essa chamada aqui usa o número real e cria
  // um SEGUNDO registro de contato pro mesmo cliente. Se já sabemos o lid
  // equivalente a este jid, localizamos o registro antigo pra migrar em
  // vez de duplicar.
  let phoneProvisorio = null;
  if (isPhoneJid) {
    const lidEquivalente = resolveJidToLid(rawUserId);
    if (lidEquivalente) {
      phoneProvisorio = lidEquivalente.replace(/@lid$/i, "").replace(/\D/g, "") || null;
    }
  }

  try {
    const existing = await pool.query(
      `SELECT id, nome FROM contacts WHERE whatsapp = $1::varchar LIMIT 1`,
      [phone]
    );

    if (existing.rows.length) {
      const currentName = String(existing.rows[0].nome || "").trim();
      const looksGeneric = !currentName || currentName === phone || /^\d{8,15}$/.test(currentName);

      if (safeName !== phone && looksGeneric) {
        await pool.query(
          `UPDATE contacts SET nome = $1::text, updated_at = NOW() WHERE id = $2`,
          [safeName, existing.rows[0].id]
        );
        logger.info(`[CONTACT_UPDATED] ${phone} nome="${safeName}"`);
        emitEvent("contacts_updated", { reason: "auto_contact_update", whatsapp: phone });
      }

      return existing.rows[0].id;
    }

    if (phoneProvisorio) {
      const antigo = await pool.query(
        `SELECT id, nome FROM contacts WHERE whatsapp = $1::varchar LIMIT 1`,
        [phoneProvisorio]
      );

      if (antigo.rows.length) {
        const currentName  = String(antigo.rows[0].nome || "").trim();
        const looksGeneric  = !currentName || currentName === phoneProvisorio || /^\d{8,15}$/.test(currentName);
        const nomeFinal     = (safeName !== phone && looksGeneric) ? safeName : (currentName || safeName);

        await pool.query(
          `UPDATE contacts SET whatsapp = $1::varchar, nome = $2::text, updated_at = NOW() WHERE id = $3`,
          [phone, nomeFinal, antigo.rows[0].id]
        );
        logger.info(`[CONTACT_MERGED] lid=${phoneProvisorio} → jid=${phone} nome="${nomeFinal}"`);
        emitEvent("contacts_updated", { reason: "auto_contact_merge", whatsapp: phone });
        return antigo.rows[0].id;
      }
    }

    // Pedido do usuário (2026-07-24): todo contato novo nasce marcado como
    // "Leads" (renomeado de "Clientes Novos" em 2026-07-31 — ver
    // contacts.service.js) — vira "Clientes" automaticamente quando gerar o
    // 1º ticket de verdade (ver marcarComoCliente em contacts.service.js,
    // chamado por ticket.service.js/createTicket).
    const inserted = await pool.query(
      `INSERT INTO contacts (nome, whatsapp, status, tags)
       VALUES ($1::text, $2::varchar, 'ativo', ARRAY['Leads']::text[])
       RETURNING id`,
      [safeName, phone]
    );

    logger.info(`[CONTACT_CREATED] ${phone} nome="${safeName}"`);
    emitEvent("contacts_updated", { reason: "auto_contact", whatsapp: phone });
    return inserted.rows[0]?.id || null;
  } catch (err) {
    logger.warn(`[AutoContact] falhou para ${phone}: ${err.message}`);
    return null;
  }
}

// Nome REAL do contato (perfil do WhatsApp, tabela contacts) — fonte
// única usada em vários pontos do sistema (saudação do bot, saudação de
// atendente, pesquisa de satisfação, envio manual do painel) que antes
// cada um resolvia o nome à sua maneira, gerando bugs de contaminação:
//   - main.flow.js usava tickets.customer_name (nome DIGITADO num
//     orçamento antigo, podia estar errado/desatualizado);
//   - ticket.controller.js usava ticket.customerName direto (mesmo
//     problema, e ainda "vazava" pra dentro da tabela history);
//   - message.controller.js buscava "o contact_name mais recente no
//     histórico" — que podia já estar contaminado por uma das mensagens
//     acima, propagando o nome errado pra sempre (efeito cascata).
// Nome só com dígitos (placeholder de telefone salvo antes do nome real
// ser conhecido — ver autoRegisterContact) é ignorado, retorna null.
function _pareceApenasDigitos(nome) {
  return /^\d+$/.test(String(nome || "").trim());
}

async function buscarNomeContatoReal(userId) {
  try {
    const candidatos = getProfilePhotoCandidates(userId);
    const telefones = Array.from(new Set(
      (candidatos.length ? candidatos : [userId])
        .map(c => String(c || "").replace(/@(s\.whatsapp\.net|lid)$/i, "").replace(/\D/g, ""))
        .filter(Boolean)
    ));
    if (!telefones.length) return null;

    const res = await pool.query(
      `SELECT nome FROM contacts
       WHERE whatsapp = ANY($1::text[])
         AND nome IS NOT NULL AND nome != ''
       ORDER BY updated_at DESC LIMIT 1`,
      [telefones]
    );
    const nome = res.rows[0]?.nome;
    return (nome && !_pareceApenasDigitos(nome)) ? nome : null;
  } catch (err) {
    logger.warn(`[buscarNomeContatoReal] ${err.message}`);
    return null;
  }
}

// Bloqueio de contatos marcados como "Funcionário" (pedido do usuário,
// 2026-07-24): quando o bot está processando normalmente, ele não deve
// responder a ninguém marcado com essa tag no cadastro de contatos — típico
// caso de alguém da própria equipe testando pelo WhatsApp pessoal, ou um
// número interno que não deve receber atendimento automático. Usa
// getProfilePhotoCandidates() como buscarNomeContatoReal() acima: o mesmo
// contato físico pode estar salvo sob a variante @lid OU @s.whatsapp.net,
// então checar só a chave exata do userId recebido deixaria a tag "furar"
// quando o WhatsApp entrega a mensagem pela outra variante do mesmo número.
const TAG_FUNCIONARIO = "Funcionário";

async function contatoTemTagFuncionario(userId) {
  try {
    const candidatos = getProfilePhotoCandidates(userId);
    const telefones = Array.from(new Set(
      (candidatos.length ? candidatos : [userId])
        .map(c => String(c || "").replace(/@(s\.whatsapp\.net|lid)$/i, "").replace(/\D/g, ""))
        .filter(Boolean)
    ));
    if (!telefones.length) return false;

    const res = await pool.query(
      `SELECT 1 FROM contacts
       WHERE whatsapp = ANY($1::text[])
         AND $2 = ANY(tags)
       LIMIT 1`,
      [telefones, TAG_FUNCIONARIO]
    );
    return res.rows.length > 0;
  } catch (err) {
    // Falha segura: erro na checagem não deve travar/derrubar o atendimento
    // de ninguém — só loga e trata como "não é funcionário" (comportamento
    // igual ao resto do pipeline de auto-registro nesta função).
    logger.warn(`[contatoTemTagFuncionario] ${err.message}`);
    return false;
  }
}

module.exports = { autoRegisterContact, buscarNomeContatoReal, contatoTemTagFuncionario };
