# Melhorias de produção aplicadas — etapa 02

## Segurança

- Criado `src/middlewares/security.js` com:
  - `originGuard`: bloqueia requisições mutáveis vindas de origens não permitidas quando a autenticação é por cookie.
  - `securityHeaders`: adiciona `X-Request-Id`, `X-Content-Type-Options` e `Referrer-Policy`.
- `express.json` agora usa `JSON_BODY_LIMIT` configurável no `.env`.
- CORS e CSP continuam configuráveis por ambiente.

## Autenticação e validação

- Login e atualização de perfil agora têm validação com Zod.
- Criação de usuário e reset de senha agora têm validação com Zod.
- Tempo de sessão agora pode ser ajustado com `SESSION_TTL_MINUTES`.

## Logs

- `logger.js` foi migrado para Pino com escrita assíncrona em produção.
- Logs sensíveis são redigidos automaticamente: cookies, authorization, senha e token.
- Logs de acesso foram estruturados com `requestId`, método, URL, status, IP e tempo de resposta.

## Healthchecks

- `/api/live`: indica que o processo Node está vivo.
- `/api/ready`: valida se o banco está acessível.
- `/health` e `/api/health`: resposta simples para checagem rápida.

## Permissões

- Criado `requireSupervisorOrAdmin`.
- Métricas, campanhas e logs de atividade foram liberados para supervisor/admin.
- Configurações, usuários e respostas rápidas continuam apenas para admin.

## Deploy

- Adicionado `Dockerfile`.
- Adicionado `docker-compose.prod.example.yml`.
- `.env.example` atualizado com novas variáveis.

## Próxima etapa sugerida

- Criar testes automatizados mínimos.
- Padronizar migrations numeradas.
- Revisar regras de permissão por rota no painel inteiro.
- Separar upload público de upload privado com rota autenticada.
