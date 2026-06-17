/**
 * DEPRECATED — este middleware NÃO está em uso.
 *
 * A autenticação da API é feita por `authSession` exportado de
 * `src/routes/auth.routes.js`, que valida sessões no banco PostgreSQL
 * e também aceita API_TOKEN via Bearer para integrações externas.
 *
 * Este arquivo é mantido apenas para referência histórica.
 * Não importe nem use authMiddleware em nenhuma rota nova.
 */

module.exports = {};
