# Revisão de segurança — bot Rildon (2026-08-17)

Autoavaliação feita como parte da esteira de qualidade (Issue #6), não uma
auditoria de terceiros. Escopo: o painel de atendimento + API
(`src/`), não os scripts de automação do X2 (`scripts/x2-*`, que rodam
localmente contra um portal de fornecedor, fora do perímetro exposto).

## O que já está em vigor (confirmado lendo o código, 2026-08-17)

- **Senhas**: hash com `bcrypt` em todo lugar que grava/compara senha
  (`src/routes/auth.routes.js`, `src/services/user.service.js`), nunca em
  texto puro. Códigos de backup do 2FA também hasheados
  (`src/services/twoFactor.service.js`).
- **2FA**: TOTP implementado (`otplib`) com fluxo de verificação e códigos
  de backup, aplicado no login (`/api/auth/login/verify-2fa`).
- **Sessão**: cookie `rildon_sid` com `httpOnly: true` (JS do cliente não
  acessa), `sameSite: "strict"` (mitiga CSRF), `secure` condicional a
  `COOKIE_SECURE` no `.env` (ver limitação abaixo).
- **SQL**: 100% via query parametrizada (`$1`, `$2`, ...) do driver `pg` —
  varredura em `src/repositories/*.js` não achou nenhuma concatenação de
  string do usuário direto numa query.
- **Autorização**: centralizada em `src/app.js`, não espalhada por arquivo
  de rota — cada grupo de rotas é montado com `authSession` (exige login)
  e, quando cabe, `requireAdmin`/`requireRole("admin","supervisor")`.
  Configurações, usuários, quick-replies e log de auditoria exigem admin;
  métricas e broadcast exigem admin ou supervisor; o resto exige só login.
- **Rate limiting**: `express-rate-limit` aplicado globalmente em `/api`
  (`apiLimiter`) mais limiters mais restritos em login, mensagens, upload e
  ações críticas (`src/middlewares/rate-limiters.js`), com chave por
  sessão (não só IP) — resolve o problema real de vários atendentes atrás
  do mesmo IP de rede local dividirem o mesmo balde (ver comentário no
  próprio arquivo).
- **Upload de arquivo**: todo `multer` usado no projeto (perfil, mídia de
  broadcast, CSV de contatos) tem `limits.fileSize` E `fileFilter`
  validando extensão/mimetype — não aceita qualquer arquivo.
- **Headers HTTP**: `helmet` com CSP explícita (não é só o default),
  `frameAncestors: 'none'`, `objectSrc: 'none'`.
- **Erros**: `error-handler.js` nunca devolve stack trace pro cliente —
  5xx vira mensagem genérica + `requestId` pra achar o log real no
  servidor; o erro completo só vai pro log interno + Sentry.
- **Segredos**: `.env`/`.env.*` no `.gitignore`, nada commitado; varredura
  por padrão de secret hardcoded (`grep` por `senha=`/`token=`/`key=`
  seguido de string literal) não achou nada em `src/`.

## Gaps e decisões conscientes (não são bugs escondidos)

- **Cookie `secure` depende de `COOKIE_SECURE` no `.env`, e o deploy roda
  em HTTP puro na rede local** (Docker + acesso por IP da LAN, sem
  reverse proxy/TLS na frente — ver memória `bot Rildon: CORS_ORIGIN e
  acesso por outros IPs`). Isso significa que hoje o cookie de sessão
  trafega sem criptografia dentro da rede da loja. Pra uma rede interna
  confiável isso é um risco aceito, não ignorado — mas vale registrar:
  se algum dia o painel for exposto fora da rede local (VPN incluída,
  dependendo de como for configurada), **isso precisa virar HTTPS
  primeiro** (nginx/Caddy como reverse proxy TLS na frente do container,
  com `COOKIE_SECURE=true`).
- **`npm audit --audit-level=high` já roda no CI** (`ci.yml`, passo
  anterior a esta mudança) — mantém as dependências monitoradas, mas só
  pega vulnerabilidade conhecida/publicada, não substitui revisão de
  código.
- **Sem WAF/proteção de força-bruta distribuída** — o rate limit é por
  processo Node (em memória), reseta se o container reiniciar, e não
  protege contra um ataque distribuído de várias origens. Proporcional
  pro tamanho real do deploy (rede local, ~5 usuários); não seria
  suficiente se o painel virasse público na internet.
- **Sem rotação automática de segredo de sessão** — não auditado a fundo
  neste passe (fora do escopo desta 1ª rodada); revisar em conjunto com
  `src/routes/auth.routes.js` se o painel algum dia sair da rede local.

## O que este documento NÃO cobre

Não é pentest, não roda scanner automatizado (nenhum SAST/DAST configurado
ainda), e não cobre a infraestrutura de host/Docker/rede em si (isso é
responsabilidade do usuário no ambiente de deploy). Reavaliar sempre que o
modelo de exposição mudar (ex: painel sair da rede local).
