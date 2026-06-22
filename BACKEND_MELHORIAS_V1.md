# Melhorias Backend V1

Aplicado nesta versão:

- Regras centralizadas de autorização em `utils/access-control.js`.
- Atendentes agora só alteram/transferem tickets que realmente podem gerenciar.
- Assumir ticket valida setor/permissão no backend.
- Envio manual, digitação e devolução ao bot validam acesso à conversa/ticket.
- Dashboard sensível de tickets restrito a supervisor/admin/API.
- Upload de campanhas validado por extensão + MIME, bloqueando SVG e arquivos disfarçados.
- Upload de foto de perfil validado por extensão + MIME.
- `.gitignore` para evitar logs, sessões, uploads e `.env` no repositório.

Observação: o ZIP original possui duas árvores de código (`src/` e `src/backend/`). As melhorias foram aplicadas nas duas para evitar diferença de deploy. A próxima etapa recomendada é escolher uma estrutura canônica e remover a duplicada com segurança.
