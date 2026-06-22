# Backend v5 — Estabilidade integrada

## Correções aplicadas

- Removidos uploads reais do pacote final.
- Removido contador JSON legado `tickets_contador.json`.
- Mantidas apenas pastas de runtime com `.gitkeep`.
- Caminho do frontend servido pelo backend agora é resiliente:
  - pacote integrado: `../../frontend`;
  - backend isolado: `../frontend`.
- Presença online via Socket.IO agora suporta múltiplas abas/conexões por usuário.
- Contatos emitem evento `contacts_updated` após criar, editar, importar e excluir.
- Campanhas emitem evento `broadcasts_updated` após criar, upload de mídia, iniciar, cancelar, repetir e excluir.
- Frontend escuta `contacts_updated` e `broadcasts_updated` e atualiza a tela aberta automaticamente.

## Observações

- `/socket.io/socket.io.js` continua vindo do backend em execução, portanto não aparece como arquivo local no ZIP.
- As pastas `src/uploads/campaigns` e `src/uploads/profiles` devem existir no deploy, mas os arquivos reais não devem ser versionados.
