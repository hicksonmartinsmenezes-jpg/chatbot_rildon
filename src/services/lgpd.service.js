/**
 * LGPD — exclusão e anonimização de dados pessoais de um cliente (titular de
 * dados), a pedido dele ou por decisão da empresa.
 *
 * Dados pessoais de clientes ficam espalhados em 3 tabelas, todas ligadas
 * pelo número de telefone (dígitos, sem "@s.whatsapp.net" — mesmo formato
 * usado em contacts.whatsapp e no restante do código, ex: validação de
 * ATENDENTE_NUMBER em src/config/env.js):
 *   - contacts:  nome, whatsapp, tags, departamento
 *   - history:   contact_name, message, response (conteúdo das conversas)
 *   - tickets:   customer_name, cpf, description
 *
 * Duas operações, propositalmente separadas:
 *
 * - anonymizeCustomerData: MANTÉM as linhas (preserva métricas/relatórios
 *   agregados — contagem de tickets por setor, histórico de volume etc.)
 *   mas substitui todo campo de identificação pessoal por um placeholder.
 *   Reversível apenas no sentido de que a estrutura continua existindo;
 *   o conteúdo original é destruído (não há "desfazer").
 *
 * - eraseCustomerData: apaga as linhas de verdade (contacts + history +
 *   tickets) para aquele número. Uso quando o titular pede exclusão total,
 *   não só anonimização.
 *
 * Ambas operam numa transação — ou tudo é feito, ou nada.
 */

const pool = require("../database/postgres");

const PLACEHOLDER_NOME = "Cliente anonimizado (LGPD)";
const PLACEHOLDER_CONTEUDO = "[conteúdo removido a pedido do titular — LGPD]";

function normalizarTelefone(whatsapp) {
  const digits = String(whatsapp || "").replace(/\D/g, "");
  if (!digits) throw new Error("Número de WhatsApp inválido.");
  return digits;
}

/**
 * Anonimiza os dados pessoais de um cliente, mantendo as linhas (para não
 * quebrar contagens/relatórios agregados que dependem dessas tabelas).
 * @returns {Promise<{ contacts: number, history: number, tickets: number }>}
 */
async function anonymizeCustomerData(whatsapp) {
  const telefone = normalizarTelefone(whatsapp);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const contactsRes = await client.query(
      `UPDATE contacts
       SET nome = $1, tags = '{}', departamento = NULL, updated_at = NOW()
       WHERE whatsapp = $2
       RETURNING id`,
      [PLACEHOLDER_NOME, telefone]
    );

    // quoted_text (migration 019) também precisa ser anonimizado — sem isso,
    // um trecho da mensagem original do cliente sobreviveria escondido na
    // prévia de citação de uma resposta, mesmo com message/response já
    // trocados pelo placeholder.
    const historyRes = await client.query(
      `UPDATE history
       SET contact_name = $1, message = $2, response = $2, quoted_text = NULL
       WHERE user_id = $3`,
      [PLACEHOLDER_NOME, PLACEHOLDER_CONTEUDO, telefone]
    );

    const ticketsRes = await client.query(
      `UPDATE tickets
       SET customer_name = $1, cpf = NULL, description = $2
       WHERE user_id = $3`,
      [PLACEHOLDER_NOME, PLACEHOLDER_CONTEUDO, telefone]
    );

    await client.query("COMMIT");

    return {
      contacts: contactsRes.rowCount,
      history: historyRes.rowCount,
      tickets: ticketsRes.rowCount
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apaga de vez os dados pessoais de um cliente nas 3 tabelas.
 * @returns {Promise<{ contacts: number, history: number, tickets: number }>}
 */
async function eraseCustomerData(whatsapp) {
  const telefone = normalizarTelefone(whatsapp);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const historyRes = await client.query(
      `DELETE FROM history WHERE user_id = $1`,
      [telefone]
    );

    const ticketsRes = await client.query(
      `DELETE FROM tickets WHERE user_id = $1`,
      [telefone]
    );

    const contactsRes = await client.query(
      `DELETE FROM contacts WHERE whatsapp = $1`,
      [telefone]
    );

    await client.query("COMMIT");

    return {
      contacts: contactsRes.rowCount,
      history: historyRes.rowCount,
      tickets: ticketsRes.rowCount
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  anonymizeCustomerData,
  eraseCustomerData
};
