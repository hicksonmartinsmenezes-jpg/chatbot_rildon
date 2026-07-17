/**
 * Detecta e funde contatos duplicados causados pelo mesmo cliente real
 * tendo DUAS linhas em `contacts` — uma salva com o número provisório
 * derivado do @lid (dispositivo vinculado, sem resolução no momento do
 * primeiro contato) e outra já com o número de telefone real
 * (@s.whatsapp.net) — usando o mapeamento lid→jid persistido em
 * `lid_map` (ver src/whatsapp/lid-map.js e migration 010).
 *
 * Origem (task #140): ao montar uma campanha de teste real, uma consulta
 * de "todos os contatos com tag Funcionário(a) + Diretor Geral" trouxe 54
 * linhas, mas deduplicar por número de WhatsApp (mesma lógica de
 * createBroadcast, ver broadcast.service.js) derrubou pra 34 números
 * únicos — indicando que boa parte dessas linhas eram duplicatas do MESMO
 * cliente sob dois formatos de identificador.
 *
 * autoRegisterContact() (src/whatsapp/contacts.js) já evita duplicatas
 * NOVAS a partir de agora (migra/funde na hora que descobre a
 * equivalência) — mas não corrige duplicatas que já existem no banco de
 * ANTES desse fix, nem clientes que nunca mandaram outra mensagem depois
 * que o mapeamento lid→jid foi aprendido por outro caminho (ex:
 * sincronização de contatos do WhatsApp). Este script é a limpeza
 * retroativa, one-off.
 *
 * Uso:
 *   node scripts/merge-duplicate-contacts.js            (dry-run — só relatório, não muda nada)
 *   node scripts/merge-duplicate-contacts.js --apply    (aplica de verdade)
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

function apenasDigitos(v) {
  return String(v || "").replace(/\D/g, "");
}

function pareceNomeGenerico(nome, telefone) {
  const n = String(nome || "").trim();
  return !n || n === telefone || /^\d{8,15}$/.test(n);
}

// Decide o resultado da fusão entre o contato "antigo" (número provisório
// derivado do @lid) e o "canônico" (número de telefone real, @s.whatsapp.net).
// Função pura — sem acesso a banco — pra ser testável em isolamento.
function decidirFusao(antigo, canonico) {
  const nomeAntigoGenerico = pareceNomeGenerico(antigo.nome, antigo.whatsapp);
  const nomeCanonicoGenerico = pareceNomeGenerico(canonico.nome, canonico.whatsapp);

  // Prefere o nome REAL (não genérico) — se só o canônico tem nome
  // genérico (ex: telefone salvo como nome) e o antigo já tinha um nome
  // de verdade digitado antes, usa o do antigo em vez de perder essa info.
  const nome = (nomeCanonicoGenerico && !nomeAntigoGenerico) ? antigo.nome : canonico.nome;

  // União das tags dos dois registros — nenhuma etiqueta já atribuída se perde na fusão.
  const tags = Array.from(new Set([...(canonico.tags || []), ...(antigo.tags || [])]));

  // Mantém quem já tinha atendente designado (prioriza o canônico, já que
  // é o registro que sobrevive).
  const atendenteId = canonico.atendente_id || antigo.atendente_id || null;

  // "ativo" vence se qualquer um dos dois estava ativo — evita que uma
  // fusão silenciosamente desative um contato que estava em uso.
  const status = (canonico.status === "ativo" || antigo.status === "ativo") ? "ativo" : canonico.status;

  return { nome, tags, atendenteId, status };
}

async function main() {
  const pool = require("../src/database/postgres");
  const apply = process.argv.includes("--apply");

  const lidMapRes = await pool.query(`SELECT lid, jid FROM lid_map`);
  const contactsRes = await pool.query(
    `SELECT id, nome, whatsapp, status, tags, atendente_id FROM contacts`
  );
  const contacts = contactsRes.rows;
  const byPhone = new Map(contacts.map(c => [c.whatsapp, c]));

  let mergeCount = 0;
  let renameCount = 0;

  for (const { lid, jid } of lidMapRes.rows) {
    const lidPhone = apenasDigitos(lid);
    const jidPhone = apenasDigitos(jid);
    if (!lidPhone || !jidPhone || lidPhone === jidPhone) continue;

    const antigo = byPhone.get(lidPhone);
    const canonico = byPhone.get(jidPhone);

    if (antigo && canonico && antigo.id !== canonico.id) {
      const fusao = decidirFusao(antigo, canonico);
      console.log(
        `[MERGE] ${antigo.whatsapp} ("${antigo.nome}") → ${canonico.whatsapp} ("${fusao.nome}") | tags finais: ${fusao.tags.join(", ") || "-"}`
      );
      mergeCount++;
      if (apply) {
        await pool.query(
          `UPDATE contacts SET nome=$1, tags=$2, atendente_id=$3, status=$4, updated_at=NOW() WHERE id=$5`,
          [fusao.nome, fusao.tags, fusao.atendenteId, fusao.status, canonico.id]
        );
        await pool.query(`DELETE FROM contacts WHERE id=$1`, [antigo.id]);
      }
    } else if (antigo && !canonico) {
      console.log(`[RENAME] ${antigo.whatsapp} ("${antigo.nome}") → ${jidPhone} (sem contato canônico ainda)`);
      renameCount++;
      if (apply) {
        await pool.query(`UPDATE contacts SET whatsapp=$1, updated_at=NOW() WHERE id=$2`, [jidPhone, antigo.id]);
      }
    }
  }

  // Diagnóstico extra: duplicatas LITERAIS (mesmo whatsapp em duas linhas,
  // sem nenhuma relação com lid/jid) — não são fundidas automaticamente
  // aqui, porque sem o mapeamento lid_map não há como saber qual das duas
  // linhas é "a certa"; só reporta pra revisão manual.
  const porTelefone = new Map();
  for (const c of contacts) {
    if (!porTelefone.has(c.whatsapp)) porTelefone.set(c.whatsapp, []);
    porTelefone.get(c.whatsapp).push(c);
  }
  const duplicatasLiterais = [...porTelefone.values()].filter(list => list.length > 1);
  if (duplicatasLiterais.length) {
    console.log(
      `\n⚠️  ${duplicatasLiterais.length} número(s) com MAIS DE UMA linha idêntica em contacts (sem relação com lid/jid — revisar manualmente):`
    );
    for (const list of duplicatasLiterais) {
      console.log(`   ${list[0].whatsapp}: ${list.map(c => `id=${c.id} nome="${c.nome}"`).join(" | ")}`);
    }
  }

  console.log(
    `\n${apply ? "Aplicado" : "[DRY-RUN] Seria aplicado"}: ${mergeCount} fusão(ões), ${renameCount} renomeação(ões).`
  );
  if (!apply && (mergeCount || renameCount)) {
    console.log(`Rode com --apply pra executar de verdade.`);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    console.error("Falha ao mesclar contatos duplicados:", err.message);
    process.exit(1);
  });
}

module.exports = { apenasDigitos, pareceNomeGenerico, decidirFusao };
