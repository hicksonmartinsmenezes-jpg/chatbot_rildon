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

### 3. Deploy continua manual pelo usuário — documente o que é preciso no PR

Este projeto roda em Docker local (`chatbot_rildon_app` +
`chatbot_rildon_postgres`, ver `docker-compose.yml`, volume `.:/app` —
código já reflete ao vivo, sem rebuild de imagem). O agente nunca reinicia
o container nem roda migration no banco real — só o usuário faz isso, no
terminal dele. Todo PR deve deixar explícito no "Próximos passos":

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

### 4. Antes de considerar a tarefa concluída

- Rodar a suíte de testes relevante (`npx jest ...`) e reportar resultado
  real no PR — inclusive suítes puladas de propósito (ex:
  `ticket.service.manual-reopen-satisfaction.test.js` trava sem Postgres
  real no sandbox de agente — limitação conhecida, não é regressão).
- Validar ao vivo quando a mudança for visível/testável no painel rodando
  (`localhost:3000`) — screenshot ou verificação funcional, não só "os
  testes passaram".
- Só então marcar a tarefa/Issue como pronta para review/merge.

---

Convenções técnicas do projeto (arquitetura, testes, migrations) continuam
descritas nos demais arquivos de referência do repositório
(`README_MODULARIZACAO.md`, `RAIO_X_GERAL_V17.md`, `src/database/migrations/README.md`).
Este arquivo cobre especificamente o processo de gestão de mudanças
(Issue → PR), que passa a valer para todo agente, independente do modelo.
