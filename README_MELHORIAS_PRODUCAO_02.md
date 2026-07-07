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

## Nota de divergência (2026-07-07)

Uma auditoria do código atual encontrou diferenças entre o que este
changelog descreve e o que existe hoje em `src/`. Mantido o texto acima
como registro histórico, mas para quem for mexer no código, o estado real
é:

- **`src/middlewares/security.js` (`originGuard`) não existe** no código
  atual. A mitigação de CSRF hoje vem do cookie de sessão configurado com
  `sameSite: "strict"` em `src/routes/auth.routes.js` — funciona, só não é
  o mecanismo descrito aqui.
- **`requireSupervisorOrAdmin` não existe.** `src/middlewares/permissions.js`
  só tem `requireAdmin` (tudo ou nada). Métricas, campanhas e logs de
  atividade estão hoje atrás de `requireAdmin` em `src/app.js`, não de uma
  hierarquia admin/supervisor. Se o nível "supervisor" for necessário,
  precisa ser implementado — não é só reativar algo que já existiu.
- "Criar testes automatizados mínimos" foi feito (Jest + `tests/`), mas
  o `test-flow.js` (97 testes do fluxo conversacional) ainda não roda no
  CI — ver tarefa em andamento sobre isso.
- "Separar upload público de upload privado" segue como está: `/uploads/*`
  em `src/app.js` é público por decisão consciente (comentário no código
  explica o motivo), não por omissão. Vale revisar se ainda é aceitável.
