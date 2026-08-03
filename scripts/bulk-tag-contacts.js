/**
 * Aplica uma tag em massa a uma lista de contatos (nome + whatsapp), criando
 * o contato se ele ainda não existir no banco.
 *
 * Pedido do usuário (2026-08-03): "Listas Específicas" por vendedor (ex:
 * "Contatos Rafael", "Contatos Gustavo" etc.) — o usuário vai mandar, aos
 * poucos, a lista de contatos de cada vendedor (exportada do celular), já
 * filtrada por mim (Claude) pra tirar duplicatas e contatos que são só
 * setor/cargo interno da própria loja (motoboy, balcão, estoque, TI etc.).
 *
 * Por que não reaproveitar o import de CSV que já existe
 * (contacts.service.js/bulkImportContacts, usado pelo botão "Importar" do
 * painel de Contatos): aquele import só faz INSERT de contatos que ainda
 * NÃO existem (`toInsert = unique.filter(r => !existing.has(r.whatsapp))`)
 * — contatos que já existem no banco (bem provável, já que muitos desses
 * clientes já mandaram mensagem pro bot alguma vez) são simplesmente
 * IGNORADOS, sem receber a tag nova. Pra "Listas Específicas" isso não
 * serve: precisamos ATUALIZAR quem já existe (acrescentar a tag, sem
 * duplicar nem apagar as tags que já tinha) e só criar do zero quem
 * realmente não existe ainda.
 *
 * Uso:
 *   node scripts/bulk-tag-contacts.js "Contatos Rafael" data/contatos-rafael.json
 *
 * O arquivo JSON é um array de objetos: [{ "nome": "...", "whatsapp": "..." }, ...]
 * (whatsapp pode vir com ou sem formatação — só os dígitos são usados).
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const fs = require("fs");
const pool = require("../src/database/postgres");
const { emitEvent } = require("../src/services/socket.service");

async function main() {
  const [, , tag, arquivo] = process.argv;

  if (!tag || !arquivo) {
    console.error('Uso: node scripts/bulk-tag-contacts.js "<nome da tag>" <arquivo.json>');
    process.exit(1);
  }

  const conteudo = fs.readFileSync(path.resolve(arquivo), "utf-8");
  const lista = JSON.parse(conteudo);

  if (!Array.isArray(lista) || !lista.length) {
    console.error("Arquivo vazio ou em formato inválido (esperado: array de {nome, whatsapp}).");
    process.exit(1);
  }

  // Dedup por telefone dentro do próprio arquivo, mesmo que o filtro anterior
  // já deva ter feito isso — defesa extra, não custa nada.
  const porTelefone = new Map();
  for (const item of lista) {
    const digits = String(item.whatsapp || "").replace(/\D/g, "");
    if (!digits) continue;
    if (!porTelefone.has(digits)) porTelefone.set(digits, item.nome || "(sem nome)");
  }

  let criados = 0;
  let marcados = 0;
  let jaTinhamTag = 0;
  let erros = 0;

  for (const [whatsapp, nome] of porTelefone) {
    try {
      const existente = await pool.query(
        `SELECT id, tags FROM contacts WHERE whatsapp = $1 LIMIT 1`,
        [whatsapp]
      );

      if (existente.rows.length) {
        const contato = existente.rows[0];
        const tagsAtuais = Array.isArray(contato.tags) ? contato.tags : [];
        if (tagsAtuais.includes(tag)) {
          jaTinhamTag++;
          continue;
        }
        await pool.query(
          `UPDATE contacts SET tags = array_append(tags, $1), updated_at = NOW() WHERE id = $2`,
          [tag, contato.id]
        );
        marcados++;
      } else {
        await pool.query(
          `INSERT INTO contacts (nome, whatsapp, tags) VALUES ($1, $2, $3)`,
          [nome, whatsapp, [tag]]
        );
        criados++;
      }
    } catch (err) {
      erros++;
      console.error(`Erro no contato ${nome} (${whatsapp}): ${err.message}`);
    }
  }

  emitEvent("contacts_updated", { reason: "bulk_tag", tag });

  console.log(`\nTag "${tag}" aplicada.`);
  console.log(`  Contatos no arquivo (após dedup):      ${porTelefone.size}`);
  console.log(`  Já existiam e ganharam a tag agora:     ${marcados}`);
  console.log(`  Já existiam e já tinham a tag:          ${jaTinhamTag}`);
  console.log(`  Criados do zero:                        ${criados}`);
  console.log(`  Erros:                                  ${erros}`);

  process.exit(0);
}

main().catch(err => {
  console.error("Falha ao aplicar tag em massa:", err.message);
  process.exit(1);
});
