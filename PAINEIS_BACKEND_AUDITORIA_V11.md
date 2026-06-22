# Auditoria V11 - Painéis/Backend

## Correções aplicadas nesta versão
- Removida a pasta duplicada `src/backend`, que continha versões antigas de `app.js`, `contact.routes.js` e `whatsapp.js`.
- Removidos logs reais, JSONs de runtime e uploads reais do pacote.
- Mantida a correção do PostgreSQL no auto-registro de contatos:
  - `$1::text`
  - `$2::varchar`
- Mantido fallback 204 para `/api/contacts/photo` quando não houver foto.
- Mantido fallback 204 para `/sounds/message.ogg` e `/sounds/ticket.ogg`.

## Observação
Este pacote contém backend (`src/`), mas não contém a pasta `frontend/`.
Para auditoria visual completa dos painéis, envie o pacote integrado com frontend + backend.
