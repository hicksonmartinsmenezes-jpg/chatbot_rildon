# Migrations — histórico e convenção

O runner (`src/database/migrate.js`) aplica todos os `.sql` desta pasta em
ordem alfabética, registrando cada arquivo já aplicado em `migrations_log`.
Como a ordenação é alfabética (não numérica sequencial estrita), buracos na
numeração **não quebram a execução** — mas atrapalham a rastreabilidade.

## Numeração atual

```
001_add_image_url_broadcasts.sql
002_constraints_and_fixes.sql
003_create_audit_logs.sql
004_gestao_sector_humanmode.sql
009_contacts.sql
010_lid_map.sql
011_add_totp_2fa.sql
012_add_missing_indexes.sql
013_add_contacts_indexes.sql
014_add_crediario_sector.sql
015_satisfaction_survey.sql
016_ticket_assigned_status_index.sql
```

**Os números 005–008 nunca existiram neste repositório** (confirmado via
`git log --all -- src/database/migrations/`). O `schema.sql` é a fonte de
verdade para instalações novas (`psql -f schema.sql`) e já contém tudo,
incluindo o que teria sido coberto por essas migrations que não chegaram a
ser criadas como arquivo incremental.

**Risco real**: se algo foi adicionado direto no `schema.sql` sem um
arquivo de migration correspondente, um banco de produção que só recebeu
migrations incrementais (nunca rodou o `schema.sql` completo de novo) pode
estar com schema desatualizado em relação ao `schema.sql` atual, sem que o
runner acuse isso. Antes de assumir que produção está em dia, vale comparar
o schema real do banco com `schema.sql` (ex: `pg_dump --schema-only`).

## Convenção daqui para frente

- Próxima migration: `016_*.sql`. Não reutilizar nem pular números.
- Toda mudança de schema deve ir para **os dois lugares**: o arquivo de
  migration incremental (para bancos existentes) E o `schema.sql` (para
  instalações novas).

## 015 — pesquisa de satisfação

Adiciona `satisfaction_rating`/`satisfaction_asked_at`/`satisfaction_rated_at`
em `tickets`. Ao fechar um atendimento (status → `resolvido`), o cliente
recebe automaticamente uma mensagem pedindo pra avaliar de 1 a 5; a resposta
fica registrada no próprio ticket (sem tabela nova).

## 016 — índice (status, assigned_to)

Suporta a consulta "quantos tickets em_andamento cada atendente tem agora"
(painel Usuários, GET /api/users) — não existia índice cobrindo
`assigned_to` sozinho antes desta migration.
