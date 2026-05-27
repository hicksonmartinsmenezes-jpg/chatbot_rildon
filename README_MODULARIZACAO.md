# Chatbot Rildon — Frontend Modularizado

Este pacote mantém o projeto original, mas substitui o `frontend/app.js` único por arquivos separados em `frontend/js/`.

## Estrutura criada

frontend/js/
- 00-core.js — estado global do painel
- 01-utils.js — helpers, toast, avatar, formatação
- 02-auth.js — login, sessão e apiFetch
- 03-navigation.js — abas, sidebar e refresh geral
- 04-history.js — histórico
- 05-metrics.js — cards e gráficos da aba Métricas
- 06-tickets.js — tickets, status, assumir, transferir e gráficos do dashboard
- 07-conversations.js — conversas, chat e digitação
- 08-settings.js — configurações e respostas rápidas
- 09-users.js — usuários do painel
- 10-logs.js — logs de atividade
- 11-profile.js — perfil e permissões
- 12-socket.js — Socket.IO e tempo real
- 13-main.js — inicialização

## Importante

- O arquivo antigo foi salvo como `frontend/app.original.backup.js`.
- O `frontend/index.html` já foi atualizado para carregar os arquivos novos.
- A pasta `auth_info/` foi removida por segurança, pois contém sessão/credenciais do WhatsApp.
- As pastas de backup automático foram removidas para deixar o ZIP mais leve.

## Como usar

1. Extraia o ZIP.
2. Entre na pasta `bot`.
3. Rode:

```bash
npm install
npm start
```

ou o comando que você já usa no projeto.

