# Política de dados pessoais e LGPD

Este documento descreve, para fins de conformidade com a Lei Geral de
Proteção de Dados (Lei 13.709/2018), quais dados pessoais o sistema coleta,
por quê, por quanto tempo, e como um titular (cliente) pode pedir acesso,
correção, anonimização ou exclusão dos seus dados.

**Preencher antes de publicar/usar em produção**: nome e contato do
Encarregado de Dados (DPO) da empresa — campos `[PREENCHER]` abaixo.

---

## 1. Quais dados pessoais o sistema coleta

| Dado | Onde fica | Finalidade |
|---|---|---|
| Nome | `contacts.nome`, `history.contact_name`, `tickets.customer_name` | Identificar o cliente no atendimento |
| Número de WhatsApp | `contacts.whatsapp`, `history.user_id`, `tickets.user_id` | Canal de comunicação (é o identificador técnico do cliente no sistema) |
| CPF | `tickets.cpf` | Processos que exigem identificação fiscal (ex: crediário) |
| Conteúdo das conversas | `history.message`, `history.response` | Histórico de atendimento, auditoria, contexto para a IA |
| Estado/UF, tags, departamento | `contacts.estado/tags/departamento` | Segmentação comercial |

Não há coleta de dados sensíveis (Art. 5º, II da LGPD — origem racial,
convicção religiosa, saúde, biometria etc.) por design dos fluxos atuais.
Se um novo fluxo vier a coletar algo assim, este documento precisa ser
revisado antes de entrar em produção.

## 2. Base legal (Art. 7º da LGPD)

O tratamento desses dados se baseia em:
- **Execução de contrato ou procedimentos preliminares** (Art. 7º, V): o
  cliente inicia contato pedindo orçamento, suporte ou negociação de
  crediário — o atendimento não existe sem esses dados.
- **Legítimo interesse** (Art. 7º, IX): manter histórico de atendimento
  para continuidade do relacionamento comercial.

## 3. Retenção — estado atual e decisão pendente

**Não há hoje uma rotina automática de expiração/purga de dados antigos.**
Contatos, histórico e tickets permanecem indefinidamente até uma ação
manual (ver seção 4). Isso é uma lacuna de conformidade: a LGPD exige que
dados não sejam mantidos além do necessário para a finalidade que
justificou a coleta (Art. 15).

Antes de operar como SaaS para clientes externos, definir e documentar
aqui um prazo de retenção (ex: "histórico de conversa sem atividade por
24 meses é anonimizado automaticamente") e, se decidido, implementar como
job agendado — hoje só existe a ação manual via painel.

## 4. Direitos do titular — como são atendidos hoje

Um cliente pode pedir (por WhatsApp, e-mail ou outro canal da empresa) a
anonimização ou exclusão dos seus dados. O atendimento a esse pedido é
feito por um **administrador do painel**, pelos endpoints:

- `POST /api/contacts/:id/lgpd/anonymize` — mantém as linhas em
  `contacts`/`history`/`tickets` (preserva métricas agregadas — total de
  tickets por setor, volume de atendimento etc.) mas substitui nome,
  conteúdo de mensagens, CPF e tags por um placeholder. **Não é
  reversível**: o conteúdo original é destruído, só a estrutura da linha
  continua existindo.
- `POST /api/contacts/:id/lgpd/erase` — apaga de vez as linhas
  correspondentes ao número de WhatsApp daquele contato nas 3 tabelas.
  **Não é reversível** e não preserva nem as métricas agregadas.

Ambas as ações exigem perfil `admin` (não supervisor/atendente) e ficam
registradas em `audit_logs` (ação `LGPD_ANONYMIZE` ou `LGPD_ERASE`, com o
usuário responsável, o contato alvo e a contagem de linhas afetadas em
cada tabela) — a própria ação de anonimizar/excluir dados também é um
evento auditável.

## 5. Contato do Encarregado de Dados (DPO)

- Nome: `[PREENCHER]`
- E-mail: `[PREENCHER]`
- Canal para o titular exercer seus direitos: `[PREENCHER — ex: e-mail, WhatsApp oficial da empresa]`

## 6. Dados no ambiente de desenvolvimento

A pasta do projeto é sincronizada via OneDrive. Isso inclui, quando
existentes localmente, `auth_info/` (sessão do WhatsApp) e `backups/`
(dumps do Postgres com todos os dados pessoais acima) — ambos corretamente
fora do Git (`.gitignore`), mas fisicamente presentes na nuvem da
Microsoft por causa da sincronização da pasta. Vale considerar mover esses
diretórios para fora da árvore sincronizada ou criptografá-los em repouso.
