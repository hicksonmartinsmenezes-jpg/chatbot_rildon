# CLAUDE.md — Instruções para qualquer agente de IA neste projeto

Este arquivo vale para qualquer agente (Claude, GPT, Copilot, etc.) que for
implementar mudanças neste repositório (`chatbot_rildon`). Leia antes de
começar qualquer tarefa nova.

## Fluxo obrigatório: Issue → Pull Request (a partir de 2026-08-17)

Decisão do usuário (2026-08-17): todo trabalho novo passa a ser gerenciado
por Issues e Pull Requests no GitHub
(`hicksonmartinsmenezes-jpg/chatbot_rildon`), em vez de commit direto na
`main` como era feito até aqui. Isso vale pra qualquer tarefa nova a partir
desta data — não é retroativo ao histórico de commits já existente.

### 1. Toda tarefa nova vira uma Issue antes de qualquer código

Antes de implementar, crie (ou confirme que já existe) uma Issue descrevendo
a tarefa, classificada com exatamente uma destas labels:

- **`correção`** — conserta um comportamento errado (bug).
- **`melhoria`** — ajusta/refina algo que já existe e já funciona.
- **`nova função`** — adiciona uma capacidade que não existia.

Se a tarefa pedida pelo usuário no chat não tiver uma Issue correspondente,
crie a Issue primeiro (título curto + descrição do que foi pedido e por
quê), só depois implemente.

### 2. Todo Pull Request referencia a Issue e traz 4 seções obrigatórias

Trabalho é entregue via PR (branch separada da `main`), nunca commit direto
na `main` para tarefas que passaram por esse fluxo. A descrição do PR
**sempre** inclui:

1. **Issue relacionada** — `Closes #N` (ou `Relates to #N` se não fechar
   completamente) logo no início da descrição.
2. **O que mudou** — resumo técnico objetivo das mudanças (arquivos/lógica
   principais), não só a lista de commits.
3. **Como foi validado** — testes automatizados rodados (comando + resultado),
   validação ao vivo feita (ex: Chrome DevTools MCP contra o painel local),
   e o que especificamente foi conferido. "Não testei" é uma resposta válida
   se for o caso — mas precisa estar escrito, não omitido.
4. **Riscos, limitações e próximos passos** — o que pode dar errado, o que
   ficou de fora do escopo de propósito, e o que precisa ser feito a seguir
   (inclusive passos de deploy do usuário — ver seção abaixo).

### 3. Deploy — o agente pode fazer, depois da esteira (decisão de 2026-11-25)

Decisão do usuário (2026-11-25), igual à já tomada no `catalogo-rildon`
(2026-11-24): o agente **pode** reiniciar o container e rodar migration no
banco real, para dar mais velocidade ao ciclo — não precisa mais esperar o
usuário fazer manualmente. Este projeto roda em Docker local
(`chatbot_rildon_app` + `chatbot_rildon_postgres`, ver `docker-compose.yml`,
volume `.:/app` — código já reflete ao vivo, sem rebuild de imagem) **no
servidor da loja**: o agente só deploya quando tem acesso a essa máquina
(ex: pelo acesso remoto/dispositivo vinculado); sem acesso, deixa os passos
no PR para o usuário. Ainda assim:

- só depois que o PR estiver com CI verde e mergeado na `main` — isso não é
  licença para pular a esteira de qualidade;
- migration continua precisando ser idempotente e sequencial;
- se o deploy falhar ou o container não subir saudável, o agente para,
  reporta o que rodou e o erro exato, e não tenta reverter sozinho no banco
  real sem o usuário saber;
- todo PR continua deixando explícito no "Próximos passos" o que foi (ou
  precisa ser) executado:

- **Mudança só de frontend** (`frontend/js`, `frontend/css`,
  `frontend/index.html`): rodar `npm run build:frontend` e, se o container
  já não pegar sozinho, `docker restart chatbot_rildon_app`.
- **Mudança de schema/migration nova** (`src/database/migrations/*.sql`):
  `docker exec -it chatbot_rildon_app npm run migrate` **e depois**
  `docker restart chatbot_rildon_app`. Nunca rodar comando de banco direto
  no host — há um Postgres nativo do Windows brigando pela porta 5432 com o
  do Docker (ver memória `bot Rildon: Postgres duplicado na porta 5432`).
- **Mudança só de backend sem migration**: `docker restart
  chatbot_rildon_app` costuma bastar (volume ao vivo).
- **Mudança no painel X2** (`scripts/x2-painel`, `scripts/x2-*.js`): reiniciar
  o "Painel X2" na loja (`Stop-Process` nos PIDs do `x2-painel` +
  `Start-ScheduledTask -TaskName "Painel X2"`).

### 4. Antes de considerar a tarefa concluída

- Rodar a suíte de testes relevante (`npx jest ...`) e reportar resultado
  real no PR — inclusive suítes puladas de propósito (ex:
  `ticket.service.manual-reopen-satisfaction.test.js` trava sem Postgres
  real no sandbox de agente — limitação conhecida, não é regressão).
- Validar ao vivo quando a mudança for visível/testável no painel rodando
  (`localhost:3000`) — screenshot ou verificação funcional, não só "os
  testes passaram".
- Só então marcar a tarefa/Issue como pronta para review/merge.

## Estoque por unidade e repositório irmão (a partir de 2026-11)

- O catálogo de produtos vive em outro repositório,
  `hicksonmartinsmenezes-jpg/catalogo-rildon` (extraído deste em 2026-11-03).
  `estoque.service.js`, `scripts/importar-estoque.js`, `postgres.js`,
  `logger.js` e `espelho.service.js` são **duplicados** nos dois — corrigiu
  um, confira o outro.
- Regra de negócio (2026-08-11): onde o X2 tem Unidade/Empresa, vale
  considerar as 3 (Matriz, Distribuidora `DIST`, Ecommerce `EC`).
  `scripts/x2-estoque-export.js` roda o "Relatório de Estoque Multiempresas"
  1× por empresa (cai no relatório simples da Matriz se falhar) e importa
  com `importar-estoque -- <csv> --empresa=<X>`; migration `029`
  (`estoque_produtos_unidade`).
- CSVs de DIST/EC ficam em `estoque/multiempresas/`: outras telas tratam o
  CSV mais recente de `estoque/` como o da Matriz.
- Login do X2: o aviso "Você está usando a sua senha inicial…" bloqueia o
  login automático (9 falhas seguidas) — trocar a senha do usuário de
  integração e atualizar `X2_SENHA` no `.env`.

## Esteira de qualidade obrigatória antes de merge na main (a partir de 2026-08-17)

Decisão do usuário (2026-08-17, Issue #6): nenhum código entra na `main`
sem passar pelo CI do GitHub Actions (`.github/workflows/ci.yml` +
`commitlint.yml`) e, quando a branch protection estiver ativa (ver
Issue #6/PR da esteira), sem aprovação da PR. O CI cobre: sintaxe
(`npm run check`), lint (`npm run lint`), testes unitários com Postgres
real de verdade num serviço do próprio workflow (`npm run test:coverage`),
teste de fluxo conversacional mockado (`npm run test:flow`), Knip (código e
dependência morta — hoje informativo, ver `continue-on-error` em
`ci.yml`), e orçamento de tamanho do bundle do frontend (`npm run
build:frontend`, falha se passar do `BUDGET_KB` em
`scripts/build-frontend.js`). `commitlint.yml` valida a mensagem dos
commits do PR contra `commitlint.config.js` — aceita qualquer prefixo de
área (`Catálogo:`, `Bot:`, ...), não força o vocabulário em inglês do
Conventional Commits, pra não brigar com a convenção que o projeto já usa
de forma consistente.

Antes desta data o `ci.yml` **nunca rodou os testes de verdade** — faltava
um serviço de Postgres no workflow, então todo run falhava com
`ECONNREFUSED 127.0.0.1:5432` independente do código, há semanas. Corrigido
no mesmo PR que criou esta seção. Se o CI voltar a ficar vermelho em toda
PR sem relação óbvia com a mudança, esse é o primeiro lugar a suspeitar.

## Princípios de arquitetura (checklist antes de abrir PR)

Pedido do usuário (2026-08-17, Issue #6) — não são regras de lint
automatizadas, são um checklist de julgamento pro agente aplicar antes de
propor uma mudança:

- **Evitar overengineering**: a escala real deste projeto é um container
  Docker + Postgres, ~5 pessoas usando o painel. Preferir a solução mais
  simples que resolve o problema pedido; abstração/camada nova precisa se
  justificar pelo problema de HOJE, não por "pode ser útil um dia".
- **Evitar bottleneck óbvio**: antes de subir uma query nova em rota
  quente (tickets, conversas, catálogo), checar se tem índice
  correspondente (`src/database/migrations/`) e se não itera em memória
  algo que o Postgres resolveria melhor com `WHERE`/`JOIN`.
- **Componentizar desde o início**: no frontend (scripts globais via
  `<script>`, sem bundler de módulos — ver
  `project-bot-rildon-frontend-bundle-gotcha` na memória), isso significa
  função utilitária reaproveitável em vez de copiar/colar HTML/lógica
  entre abas; no backend, service/repository por domínio, não lógica de
  negócio dentro do controller.
- **DRY com critério**: duplicação de 2 lugares não pede abstração nova
  por si só — abstrair cedo demais cria acoplamento errado quando os dois
  casos divergem depois. Esperar um 3º caso real antes de generalizar, a
  não ser que a duplicação já esteja causando bug (ex: dois lugares que
  precisam mudar junto e só um mudou — isso já aconteceu neste projeto,
  ver `feedback-schema-assumptions-and-test-fixtures`).
- **Não reconstruir o que já existe**: antes de escrever uma função nova,
  procurar em `frontend/js/01-utils.js` (helpers de UI/motion),
  `src/services/`, `src/database/migrations/README.md` (o que uma
  migration nova precisaria refazer) e nas memórias do agente
  (`MEMORY.md`) se esse problema já foi resolvido — este projeto tem
  histórico de funções reimplementadas por não terem sido encontradas na
  primeira busca.

---

Convenções técnicas do projeto (arquitetura, testes, migrations) continuam
descritas nos demais arquivos de referência do repositório
(`README_MODULARIZACAO.md`, `RAIO_X_GERAL_V17.md`, `src/database/migrations/README.md`).
Este arquivo cobre especificamente o processo de gestão de mudanças
(Issue → PR) e a esteira de qualidade, que passam a valer para todo agente,
independente do modelo.
