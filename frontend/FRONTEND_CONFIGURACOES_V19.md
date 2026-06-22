# Frontend Configurações v19

Correções focadas no painel Configurações > Usuários:

- Lista de usuários atualiza ao abrir a categoria Usuários.
- Criação de usuário atualiza a lista imediatamente.
- Exclusão de usuário agora faz atualização otimista na tela.
- Se a exclusão falhar, a lista volta ao estado anterior e mostra o erro.
- Botão Criar usuário fica bloqueado enquanto a requisição está em andamento.
- Botão "Tentar novamente" para falha ao carregar usuários.
- Listener Socket.IO para `users_updated`, atualizando o painel em outras abas/sessões.
- Validação de senha mínima no frontend antes de criar usuário.
- Cache bust atualizado nos scripts relacionados.

Validações executadas:

- JS sem erro de sintaxe.
- 0 eventos inline no HTML.
- 0 botões sem type.
- 0 IDs duplicados.
- Nenhum CSS/JS local faltando.
