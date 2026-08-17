# Backend Melhorias V2

## Segurança e produção

- Restrição de `/api/whatsapp/reconnect` para perfis privilegiados (`admin`, `supervisor` ou `api`).
- Rotas críticas de contatos agora exigem perfil privilegiado:
  - criar contato;
  - editar contato;
  - excluir contato;
  - exclusão em massa;
  - importar CSV;
  - exportar CSV.
- Listagem, tags, detalhe e foto de contatos continuam disponíveis para usuários autenticados.
- Importação CSV agora valida extensão e MIME antes de processar.
- Ações críticas registram auditoria em `audit_logs`:
  - reconexão WhatsApp;
  - importação/exportação de contatos;
  - criação/edição/exclusão de contatos.
- Removida estrutura duplicada `src/backend/` do pacote.
- Removidos arquivos de logs e dados JSON sensíveis do pacote.
- `.gitignore` reforçado para evitar versionar `.env`, logs, dados locais e uploads.

## Observações

As permissões reais de tickets/mensagens aplicadas na v1 foram preservadas.
- Removidos uploads reais do pacote; mantidas apenas pastas com `.gitkeep`.
