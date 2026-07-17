# Raio-X Geral do Projeto — V16 (2026-07-17)

Avaliação completa do bot Rildon Eletropeças (Node.js/Express/Baileys/PostgreSQL + painel vanilla JS), feita após a rodada de correções desta sessão (mudança de assunto no crediário, campanhas com múltiplas etiquetas, fix de lid/jid em Conversas/Tickets, script de limpeza de contatos duplicados). Cobre arquitetura, segurança, qualidade de código, testes, performance e documentação — com achados concretos, não uma repetição das auditorias anteriores.

## Visão geral

O backend tem cerca de 10.760 linhas em `src/` (12 arquivos de rotas, 20 de serviços, 6 de repositórios, 3 de controllers, 4 de fluxos de conversa), o frontend soma ~6.500 linhas em `frontend/js`, e a suíte de testes tem ~7.300 linhas em 38 arquivos. Dependências de produção são poucas e bem escolhidas (express, pg, baileys, helmet, express-rate-limit, otplib, socket.io, @sentry/node) — nada de peso morto óbvio. `npm audit --audit-level=high` roda no CI e não há vulnerabilidade conhecida pendente no momento desta avaliação.

## Arquitetura

A camada de dados é sólida: repositórios isolam SQL, serviços concentram regra de negócio, e a separação entre `contacts.js`/`lid-map.js`/`message-utils.js` (extraídos de um `whatsapp.js` que já foi de 747 linhas) mostra que refatorações de redução de complexidade já aconteceram e funcionaram.

O ponto de inconsistência real: só 3 dos 12 arquivos de rotas (`history`, `message`, `ticket`) passam por um controller dedicado. Os outros 9 — incluindo `auth.routes.js` (428 linhas) e `contact.routes.js` (318 linhas) — colocam a lógica de request/response direto no arquivo de rota, chamando serviços (ou, em alguns casos, o pool do Postgres) diretamente. Isso não é um bug, e os testes existentes (via supertest contra as rotas) cobrem esse caminho igual, mas é uma inconsistência de padrão que deixa o projeto com duas convenções diferentes para o mesmo tipo de arquivo. Se o projeto continuar crescendo, vale padronizar — não é urgente.

`main.flow.js` (775 linhas) e `ticket.controller.js` (557 linhas) são os maiores arquivos do projeto e concentram bastante lógica cada um. Nenhum dos dois está no ponto de "precisa quebrar urgente", mas são os primeiros candidatos se decidirem investir em modularização de novo.

## Segurança

Sem achados críticos. Especificamente:

Autenticação e sessão: cookie de sessão com `httpOnly`, `sameSite=strict` e `secure` condicionado a HTTPS real (evita o problema clássico de cookie descartado em rede local sem certificado). 2FA via TOTP implementado. Middleware de autorização (`authSession`, `requireAdmin`, `requireRole`) aplicado por grupo de rota em `app.js`, com rotas sensíveis (configurações, usuários, métricas, campanhas) exigindo perfil admin/supervisor.

Rate limiting: bucket geral (`apiLimiter`) cobre toda `/api`, com buckets mais restritos dedicados a login, mensagens, upload e ações críticas (fechar/transferir ticket, iniciar campanha) — arquitetura já foi corrigida numa rodada anterior (separação por feature, task #74) e continua consistente.

Injeção SQL: toda query própria usa parâmetros posicionais (`$1`, `$2`...); não encontrei nenhum template string interpolando entrada de usuário direto numa query. As duas queries de `contacts`/`history`/`ticket.repository` que fazem WHERE dinâmico (ex: `history.repository.js findAll`, alterado nesta sessão) constroem os placeholders certos.

Secrets: nenhuma chave hardcoded no código; `.env.example` cobre praticamente tudo que o código lê do ambiente (as 5 variáveis que faltavam — `BOT_MESSAGE_TIMEOUT_MS`, `BOT_PROCESSING_FALLBACK`, `BOT_FLOW_FALLBACK`, `HUMAN_MODE_TTL_MIN`, `SATISFACTION_SURVEY_WINDOW_HOURS` — já foram adicionadas durante esta avaliação).

LGPD: rotas de anonimização/exclusão de contato existem, protegidas por perfil admin + rate limit de ação crítica.

Único ponto realmente digno de nota (não é uma falha, é uma escolha já validada com você antes): `bcrypt` roda com 10 rounds — nem errado, mas mais baixo do que o recomendado hoje (12+) para senhas fortes. Como a política de senha do projeto já foi deliberadamente rebaixada pra PIN de 4 dígitos (decisão sua, registrada), 10 rounds é coerente com esse nível de risco aceito — não recomendo mexer nisso sem reabrir aquela conversa primeiro.

## Qualidade de código

Lint limpo: `npx eslint src tests scripts` retorna 0 erros e só 3 avisos de variável não usada (`env.js`, `main.flow.js`, `user.service.js`), nenhum deles introduzido nesta sessão — fácil de limpar, baixíssimo risco.

Não encontrei TODO/FIXME reais pendentes, nem `console.log` de debug esquecido fora dos pontos legítimos (logger interno, scripts de linha de comando). Um achado cosmético: existe uma pasta `src/uploads/profile` (singular) vazia, sem nenhuma referência no código — sobra de uma convenção de nome antiga antes de `uploads/profiles` (plural, que é o usado de verdade). Zero impacto funcional, mas pode ser removida numa limpeza futura.

## Testes e CI

CI (`'.github/workflows/ci.yml`) roda auditoria de dependências, checagem de sintaxe, lint, Jest e o teste de fluxo conversacional (`test-flow.js`) — pipeline completo e bem montado. A suíte tem 396 testes em 38 arquivos, todos passando.

Cobertura agregada: 60,7% de statements, 52,8% de branches. Isso esconde uma disparidade importante — alguns dos arquivos mais críticos do projeto têm cobertura baixíssima:

`message-utils.js` (2%) — arquivo que decide o TIPO de cada mensagem recebida (texto, imagem, áudio, vídeo, sticker) e extrai o texto. É exatamente a lógica que testei manualmente ao vivo nesta sessão (fotos, áudio, vídeo) porque não existe um teste automatizado que cubra isso — qualquer regressão futura aqui só seria pega em teste manual, não no CI.

`src/config/whatsapp.js` (17%) — o maior arquivo do projeto depois de `main.flow.js`, responsável pela conexão com o WhatsApp e todo o roteamento de mensagem recebida. Baixa cobertura é esperado (é o arquivo mais difícil de testar sem um WhatsApp real), mas é também o de maior superfície de risco.

`src/utils/validators.js` (31%) — contém `validarCPF`, `validarNome`, `sanitizarTexto`, `normalizar`: a base compartilhada usada por `vendas.flow.js` e `crediario.flow.js` (justamente os dois arquivos que corrigi nesta sessão). Um bug silencioso aqui afeta os dois fluxos ao mesmo tempo sem ficar óbvio em nenhum teste específico de fluxo.

Cobertura do frontend: zero (já era um ponto conhecido e de baixa prioridade desde uma auditoria anterior — segue válido, não é novidade).

## Performance e banco de dados

Indexação é consistente e bem pensada: índices simples nas colunas mais filtradas (`user_id`, `status`, `sector`, `created_at`), um composto (`status, assigned_to`) criado especificamente pra suportar a contagem "em atendimento por atendente", GIN em `tags` (array), e até um índice funcional (`REGEXP_REPLACE(cpf, '\D', '', 'g')`) que casa exatamente com a query de busca por CPF — sinal de que decisões de índice foram tomadas olhando pra query real, não por padrão.

Pool de conexões configurável via `.env` (`DB_POOL_MAX=20` por padrão) com timeouts de idle/connection sensatos. Não encontrei paginação faltando em nenhum lugar que já não tivesse sido corrigido em rodadas anteriores (`getConversationsHandler` já tem teto de 2000, listagem de tickets e histórico já paginam).

## Documentação

README cobre setup local, Docker, backup/restore/off-site e agora também a limpeza de contatos duplicados. `migrations/README.md` mantém o histórico de migrations coerente com o `schema.sql`. O gap real encontrado (5 variáveis de ambiente sem entrada no `.env.example`) já foi corrigido durante esta avaliação.

## Prioridades recomendadas

Nenhum item abaixo é urgente — o projeto está estável e em produção. Em ordem de valor pelo esforço:

1. Testes para `message-utils.js` e `validators.js` — são os dois arquivos de menor cobertura com maior "raio de explosão" se quebrarem (toda mensagem recebida passa por um, todo fluxo de coleta de dados passa pelo outro). É o investimento de teste com melhor retorno no projeto hoje.
2. Rodar `node scripts/merge-duplicate-contacts.js` (sem `--apply` primeiro) pra ver o tamanho real da duplicidade de contatos antes de decidir aplicar a limpeza.
3. Limpar os 3 avisos de lint e a pasta `uploads/profile` vazia — cosmético, mas gratuito.
4. Se o projeto continuar crescendo, considerar padronizar as 9 rotas sem controller dedicado — não por estarem erradas, mas por consistência de manutenção a longo prazo.

Nada nesta lista bloqueia uso em produção; é uma lista de "onde investir a próxima hora de trabalho", não de bugs.
