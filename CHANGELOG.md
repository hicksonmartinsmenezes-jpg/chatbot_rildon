# Changelog

Mudanças relevantes do Chatbot Rildon, a partir de 15/10/2026. Antes disso o
histórico está só nos commits — as duas tags antigas (`v1.4.0`, `v6.1-estavel`)
são de junho e não acompanharam os quatro meses seguintes.

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) ·
versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [7.0.0] — 2026-10-15

Primeira versão marcada depois da varredura completa do painel de atendimento.
Reúne as correções e as novidades entregues hoje (PRs #33 a #49).

### Adicionado

- **Exportar atendimentos em planilha** (`GET /api/metrics/exportar-csv`):
  protocolo, cliente, contato, tipo, setor, status, atendente, abertura,
  assunção, fechamento, espera, duração, nota e comentário. Separador `;` e
  BOM — abre direto no Excel em português. Aceita filtro por atendente.
- **Intervalo livre de datas** (`?de=&ate=`) no painel de relatórios, no PDF e
  no CSV. A comparação passa a ser com o período anterior de mesmo tamanho.
- **Metas de SLA**: percentual dentro da meta de 1ª resposta e de resolução,
  configuráveis por `SLA_PRIMEIRA_RESPOSTA_MIN` (15 min) e `SLA_RESOLUCAO_HORAS`
  (24 h).
- **Volume de mensagens** do período (recebidas, enviadas, clientes, por dia) —
  com o bot desligado de propósito, é o retrato mais fiel do movimento.
- **Enviar catálogo ao Drive por fabricante** no painel X2, com simulação
  marcada por padrão, acompanhamento na área Execução e resultado por
  fabricante.
- **Script de deploy** (`scripts/deploy-servidor.ps1`): leva o código do
  notebook ao servidor por SSH, reconstrói o frontend, reinicia o bot e avisa
  quando o painel X2 precisa de reinício manual.

### Corrigido

- **Tickets deixavam de ser criados com o bot desligado**: mensagens de
  clientes novos só entravam no histórico, e Pendentes, Ativos e o Dashboard
  ficavam zerados. Agora a mensagem gera um atendimento pendente.
- **Filtro de data abria em "hoje"** e esvaziava a lista de atendimentos;
  passa a abrir nos últimos 30 dias.
- **Aba "Fechados" só mostrava quem fechou no dia**; agora usa janela de 30 dias.
- **`GET /api/tickets` ignorava `?limit`** (valia sempre 500): clientes antigos
  ficavam sem atendimento mapeado e podiam reaparecer como pendentes.
- **Relatório escondia 19% dos atendimentos**: a tabela de atendentes saía do
  cadastro de usuários e excluía perfis admin. Agora sai dos próprios tickets,
  inclui quem foi desativado e traz uma linha "Sem atendente".
- **TMA/TME irreais**: o valor em destaque passou a ser a mediana (setembro:
  16 min, contra 4 dias e 22 h de média), com a média preservada na comparação
  e a cobertura declarada.
- **"Hoje" contava o dia errado** entre 21 h e a meia-noite, em três pontos
  (métricas, dashboard de tickets e card do painel).
- **Gráfico por dia pulava dias sem atendimento** (setembro aparecia com 20 de
  30 pontos).
- **Satisfação por atendente duplicava quem foi renomeado** (agrupava por nome,
  agora por id).
- **Erros de envio viravam "HTTP 500" sem motivo**: WhatsApp desconectado passa
  a responder 503 ("escaneie o QR Code") e número inexistente, 422.
- **Catálogo**: produto com duas fotos saía em meia largura ou como "sem foto".
- **Rotinas do painel X2** podiam perder a configuração em gravação
  interrompida (gravação atômica + preservação do arquivo corrompido).
- **CI**: Jest não encerrava (passou a usar `--forceExit`/`--maxWorkers=2`),
  teste instável de envio de mídia e commitlint reprovando linha longa no corpo.

### Alterado

- **Removido "Reenviar Mecânica ao Drive"** do painel X2 (substituído pelo
  envio por fabricante). O comando de linha `--todos` continua existindo.
- Opções destrutivas de "Cadastrar produtos" recolhidas em "Opções avançadas".
- Dashboard: saíram três filtros decorativos ("em desenvolvimento"), o card
  "Demanda Receptiva" (número repetido) e "Demanda Ativa" (fixo em zero).
- "Novos Contatos" passou a contar os contatos do período, não os leads
  acumulados desde sempre.
- Permissões por tela agrupadas por categoria no cadastro de usuários.
- Tempos acima de um dia aparecem como "3d 7h" em vez de "79h18".
- Recarga das métricas por socket ganhou intervalo mínimo (eram 12 consultas
  por mensagem recebida).

### Segurança

- **Dados de contatos saíram do versionamento** (`contatos/*` agora é ignorado;
  só o README fica no repositório). Os arquivos antigos permanecem no histórico
  do git — uma reescrita de histórico seria necessária para removê-los de vez.
