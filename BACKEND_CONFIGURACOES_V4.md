# Backend Configurações v4

Correções focadas no painel Configurações > Usuários:

- GET /api/users agora lista usuários ativos por padrão.
- DELETE /api/users/:id continua fazendo exclusão lógica, mas o usuário deixa de aparecer no painel imediatamente.
- Bloqueio contra excluir o próprio usuário logado.
- Bloqueio contra excluir o último administrador ativo.
- Sessões do usuário excluído são invalidadas imediatamente.
- Evento Socket.IO `users_updated` emitido ao criar, excluir e alterar senha.
- Auditoria mantida para criação, exclusão e reset de senha.
- Logs reais removidos do pacote; mantido apenas `.gitkeep`.

Validações executadas:

- JS sem erro de sintaxe.
- Requires locais verificados.
