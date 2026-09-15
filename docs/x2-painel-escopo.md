# Painel Fotos X2 — como cada parte funciona

Documento de referência técnica sobre a ferramenta `scripts/x2-painel/` — não é um tutorial de uso, é o "por baixo do capô": o que cada arquivo faz, como eles se conversam, e onde cada dado fica salvo. Escrito em 2026-09-11, depois da rodada de organização do painel (separação de CSS/JS, remoção da tela de Alertas WhatsApp) e da automação de PDF+Drive pós-Lançamentos. Mantém atualizado conforme a ferramenta mudar — é documentação viva, não uma foto única.

## O que é isso, e por que é separado do painel do bot

O "Painel Fotos X2" é um servidor Node **separado** do bot Rildon (`chatbot-rildon-backend`) — processo próprio, porta própria (`4123` por padrão), rodando direto no Windows do usuário (fora do Docker). Existe separado por dois motivos, decididos com o usuário lá no início: o X2 exige clique humano de verdade numa janela do Chrome pra abrir certas telas (nenhuma automação contorna isso), então um app "de verdade" (Electron etc.) não eliminaria essa limitação; e o painel do bot Rildon já tem várias abas de uso diário de vários atendentes — misturar uma ferramenta de manutenção de catálogo, de uso solo e ocasional, ali só atrapalharia quem depende do painel principal todo dia.

Apesar de ser um processo à parte, ele **nunca duplica dado**: lê e escreve direto nos mesmos arquivos que o bot principal usa (`src/config/catalogo-x2/<secao>.json` para produtos, `.../fotos/<secao>.zip` para fotos publicadas), e quando precisa que o bot recarregue esses dados em memória, chama a própria API HTTP do bot (`POST /api/catalogo/produtos/recarregar`) com um token — nunca mexe no processo do bot diretamente.

Abre sozinho em `http://localhost:4123` ao rodar (atalhos "Painel Fotos X2.bat" ou `npm run x2-painel`) — nunca exposto na rede, só a própria máquina acessa.

## Os três andares da ferramenta

1. **Frontend** — `scripts/x2-painel/public/{index.html, style.css, app.js}`. Uma página só, sem framework (JS puro), com 5 abas na barra lateral. Fala com o backend por `fetch()` e recebe atualizações ao vivo de execução via Server-Sent Events (`/api/log-stream`).
2. **Backend HTTP** — `scripts/x2-painel/server.js`. Um Express pequeno: serve o frontend, expõe as rotas de API, e principalmente tem o dispatcher central `rodarAcao(tipo, opcoes)` que decide qual script rodar pra cada ação.
3. **Scripts de automação** — `scripts/x2-*.js`. Cada um controla uma janela de Chrome real (via Playwright) numa tela específica do X2, faz o que precisa (baixar foto, cadastrar produto, exportar CSV etc.) e salva o resultado em disco.

## As abas da tela, uma por uma

**Catálogo** (aba padrão) — duas ações: "Atualizar Fotos" (baixa fotos dos produtos já cadastrados numa Seção, `x2-fotos-scraper.js`) e "Cadastrar produtos novos" (varre uma Seção inteira no X2 e acrescenta ao catálogo os códigos que ainda não existem, `x2-catalogo-sync.js`). A tabela de Seções à esquerda mostra quantos produtos cada uma tem, quantos já foram baixados/publicados, e sinaliza fotos suspeitas (abaixo de 400px) ou seções que ainda não bateram "Publicados" com "Baixados" (monta zip sozinho, sem clique nenhum, ver abaixo). Desde 2026-09-11, "Atualizar Fotos" tem um campo opcional "Só estes códigos" — continua precisando marcar a(s) Seção(ões) certa(s) (é lá que o script sabe abrir a tela do X2), mas restringe o download a só os códigos digitados, em vez de todos os pendentes da Seção inteira.

**Rotinas** — CRUD de agendamentos recorrentes (diário ou semanal, por horário) para qualquer uma das ações do painel. O agendador de verdade roda dentro de `server.js` (`setInterval` de 1 em 1 minuto), então só funciona enquanto o processo estiver de pé.

**Estoque** — exporta o Relatório de Estoque do X2 em CSV (`x2-estoque-export.js`) e lista exports anteriores. Também tem "Sincronizar com o Catálogo" (compara o CSV com os JSONs do catálogo e busca no X2 só os códigos que faltam, em vez de varrer a Seção inteira). A seção "Alertas automáticos (WhatsApp)" que morava aqui foi **removida da tela em 2026-09-11** (ver "Estado atual" no fim deste documento) — o backend continua funcionando, só não tem mais botão.

**Lançamentos** — busca, na tela oficial do X2 (Compras > Catálogo de Produtos, filtro "Apenas produtos com primeira entrada"), os produtos que tiveram a 1ª entrada numa janela de datas (por padrão, a última semana completa). É a peça mais nova do sistema — ver "O pipeline automático de Lançamentos" abaixo pra entender o que acontece depois da busca.

**Qualidade** — 5 categorias de divergência cadastral (Itens Inativos, Sem Foto/Arquivo, Preço de Venda Zerado, Sem Custo Médio, Apenas Cadastrados), cada uma em sua própria aba interna. As 4 primeiras vêm de um "snapshot" capturado no navegador (`x2-painel-produtos-snapshot.js`); a 5ª ("Apenas Cadastrados": sem estoque E sem preço) é calculada na hora a partir do CSV de estoque mais recente, sem precisar abrir navegador (`qualidade-apenas-cadastrados.js`).

## O motor por trás: `rodarAcao(tipo, opcoes)`

Toda ação do painel — clique manual, rotina agendada, ou disparo automático de outro fluxo — passa por essa única função em `server.js`. Ela garante que só 1 ação roda por vez (ferramenta de uso solo, sem fila), redireciona `console.log`/`console.error` pra um "terminal virtual" que é transmitido ao vivo pro navegador via SSE, e trata timeout (20 min) como rede de segurança contra travamento. Tabela de tipos válidos e o que cada um chama:

| `tipo` | O que faz | Script |
|---|---|---|
| `baixar` | Baixa fotos das Seções selecionadas (ou só dos códigos indicados, via `codigosEspecificos`) | `x2-fotos-scraper.js` |
| `sync` | Cadastra produtos novos — por Seção inteira, ou por lista de códigos específicos (`opcoes.codigos`) | `x2-catalogo-sync.js` |
| `zip` / `exportar` | Monta o zip publicado / exporta fotos soltas de uma Seção | `x2-fotos-scraper.js` |
| `estoque` | Exporta Relatório de Estoque em CSV | `x2-estoque-export.js` |
| `painel-produtos` | Snapshot dos contadores de Divergências/Situação + as 4 listas de Qualidade | `x2-painel-produtos-snapshot.js` |
| `diff-estoque` | Busca no X2 só os códigos que aparecem no CSV de estoque mas faltam no catálogo | `x2-catalogo-sync.js` (`rodarDiffEstoque`) |
| `cortes-produtos` | Alerta de estoque baixo (WhatsApp) — sem botão na tela hoje, mas o tipo continua válido | `x2-cortes-produtos-scraper.js` |
| `produtos-parados` | Alerta de produtos parados (WhatsApp) — mesma situação acima | `x2-curva-abc-parados-scraper.js` |
| `lancamentos-x2` | Busca produtos com 1ª entrada na semana + dispara o pipeline automático (ver abaixo) | `x2-lancamentos-scraper.js` |

## Rotinas — o agendador

`scripts/x2-painel/rotinas.js` guarda os agendamentos em `~/.x2-rildon-scraper/rotinas.json` (fora do projeto, não versionado) e só tem regras puras de data/hora (`deveRodarAgora`, `proximaExecucao`) — o `setInterval` que efetivamente dispara fica em `server.js`. Existem 3 frequências: "diária" e "semanal" (hora fixa do relógio — vence quando já passou do horário configurado no dia certo, e ainda não rodou desde esse horário) e "a cada N horas" (2026-09-11, sem hora fixa — vence sempre que passa `intervaloHoras` horas desde a última execução; se o painel ficou fechado além do intervalo, dispara assim que for checado de novo, em vez de esperar uma "hora cheia" programada). Isso evita tanto rodar 2x na mesma janela quanto nunca rodar se o computador estava desligado bem na hora.

Ponto de atenção real: como uma rotina pode disparar de madrugada sem ninguém na frente da tela, toda execução agendada roda em "modo automático" (`modoAutomatico: true`), que tenta logar sozinho no X2 via `X2_USUARIO`/`X2_SENHA` (`.env`) em vez de depender de uma sessão de Chrome já aberta. Essa parte (login 100% automático) ainda não foi validada ao vivo numa rotina de madrugada de verdade — se falhar, o erro fica registrado no campo `ultimoErro` da rotina, visível na tabela.

## O pipeline automático de Lançamentos

A peça mais nova do sistema (construída nesta mesma semana). Quando a rotina `lancamentos-x2` roda (manual ou agendada, toda segunda-feira em teoria), acontece isto, em sequência:

1. **Captura** — `x2-lancamentos-scraper.js` busca no X2 os produtos com "1ª entrada" no período (por padrão, a última semana completa). Salva um `.json` + planilha `.xlsx` irmã em `~/.x2-rildon-scraper/lancamentos-x2/`.
2. **Mapeamento de Seções tocadas** — `mapearSecoesTocadas()` (mesmo arquivo) tenta casar o texto de Seção de cada produto capturado com os slugs conhecidos do catálogo — best-effort, produtos que não batem entram na lista `naoMapeados` e ficam só no Excel (sem cadastro/foto automático).
3. **Cadastro Lançamentos** (`rótulo` na tela, tipo real continua `sync`) — dispara `sync.rodarPorCodigos()` só para os códigos exatos capturados, não a Seção inteira. É uma execução NOVA e independente, visível na aba Rotinas.
4. **Fotos Lançamentos** (tipo `baixar`) — dispara logo em seguida, restrito às mesmas Seções tocadas e aos mesmos códigos exatos (`codigosEspecificos` em `calcularFila`), evitando puxar de brinde o backlog antigo da Seção inteira.
5. **PDF + Drive** (`x2-drive-lancamentos.js`, sem execução própria visível — roda em segundo plano) — descobre de qual(is) fabricante(s) são os códigos tocados (consultando o próprio catálogo do bot, já atualizado pelo passo 3), gera o PDF "Catálogo Completo" de cada um (reaproveitando `GET /catalogo/exportar-pdf?fabricante=X`, o mesmo endpoint usado manualmente no painel do bot) e sobe/substitui `<fabricante>.pdf` numa pasta única do Google Drive.

Cada passo só dispara se o anterior não foi cancelado pelo usuário. O passo 5 é **best-effort**: se as credenciais do Google Drive não estiverem configuradas no `.env` ainda, ele só avisa no log e não quebra nada dos passos 3–4 (ver `.env.example`, seção "Upload automático de catálogo").

## Os scripts de automação, um por um

**`x2-nav-helpers.js`** — primitivas de navegação compartilhadas (abrir Chrome com perfil salvo, tentar login automático, clicar por texto em qualquer frame, avaliar JS em qualquer frame, retry com espera). Extraído de `x2-painel-produtos-snapshot.js` pra não duplicar ~150 linhas em cada script novo.

**`x2-fotos-scraper.js`** — baixa fotos dos produtos já cadastrados, Seção por Seção, via o popup "Catálogo de Produtos" do X2 (Vendas 3.0 > Produção de Vendas). O clique que abre esse popup é bloqueado pelo próprio X2 contra automação — por isso sempre pede 1 clique humano no início de cada sessão de Seções. Progresso salvo em `~/.x2-rildon-scraper/progress/<secao>.json`, retomável a qualquer momento.

**`x2-catalogo-sync.js`** — cadastra produtos novos na mesma tela, acrescentando ao JSON da Seção só os códigos que ainda não existem (nunca apaga/altera um já salvo, a menos que o produto tenha sumido do X2 — aí depende das opções "remover desativados"/"forçar remoção"). Produtos novos entram sempre com `ficha: null` (decisão consciente do usuário — o parser de ficha técnica original nunca foi reconstruído, e uma versão malfeita seria pior que não ter ficha nenhuma).

**`x2-lancamentos-scraper.js`** — busca a tela "Catálogo de Produtos" com o filtro "Apenas produtos com primeira entrada" = Sim, que é o X2 respondendo de verdade "isso é lançamento?" (em vez de inferir por diff de CSV, como o `lancamentos.js` legado fazia). Ver "O pipeline automático de Lançamentos" acima.

**`x2-drive-lancamentos.js`** — 3º elo do pipeline acima: descobre fabricante(s) tocados, gera PDF por fabricante reaproveitando o endpoint do bot, sobe pro Drive via conta de serviço do Google (`googleapis`). Guardas de configuração ausente (API_TOKEN, credenciais do Drive) fazem o módulo só avisar e sair, nunca derrubar o resto do pipeline.

**`x2-estoque-export.js`** — exporta o Relatório de Estoque (Logística > Relatório de Estoque) em CSV, sempre "Seção: Todos" numa exportação só. Por enquanto só baixa e guarda o arquivo — não faz parsing/estruturação além do necessário para as features que leem esse CSV depois (Lançamentos legado, Qualidade "Apenas Cadastrados").

**`x2-painel-produtos-snapshot.js`** — tira um "raio-x" da tela Compras > Gestão de Produtos > Painel: os totais de Divergências/Situação (~24 contadores) e as 4 listas de qualidade cadastral com produto-a-produto (Itens Inativos, Sem Foto/Arquivo, Preço de Venda Zerado, Sem Custo Médio). Histórico acumulado (nunca sobrescreve) em `~/.x2-rildon-scraper/painel-produtos/historico.json`.

**`x2-painel/qualidade-apenas-cadastrados.js`** — a 5ª categoria de Qualidade Cadastral, mas calculada 100% a partir do CSV de estoque já baixado (sem abrir navegador): produto com Qtd Estoque = 0 E Preço Venda Varejo = 0/vazio.

**`x2-cortes-produtos-scraper.js`** e **`x2-curva-abc-parados-scraper.js`** — os dois scripts por trás dos alertas de WhatsApp (estoque baixo com perda de faturamento real, e produtos parados via Curva ABC). Continuam funcionando via API/rotina, mas a tela que os expunha foi removida em 2026-09-11 (ver "Estado atual" abaixo). Cadência pensada originalmente: cortes diário, parados semanal.

**`x2-whatsapp-alerta.js`** — usado pelos dois scripts acima para disparar a mensagem de verdade, chamando a API HTTP do bot Rildon (`POST /api/messages/send` com `Authorization: Bearer API_TOKEN`) em vez de `docker exec`, porque enviar WhatsApp depende do socket Baileys vivo dentro do processo do bot — um processo novo via `docker exec` não teria esse socket.

**`x2-painel/lancamentos.js`** — versão **legada** de "produto novo", por diff entre snapshots diários do CSV de estoque. Superada por `x2-lancamentos-scraper.js` (que pergunta ao X2 de verdade, sem limite de data). A rota `GET /api/lancamentos` e este módulo continuam no backend, mas **a tela atual não chama mais essa rota** — código órfão, candidato a remoção numa faxina futura se ninguém precisar dele.

## Onde cada dado fica salvo

| Local | O que tem |
|---|---|
| `src/config/catalogo-x2/<secao>.json` | Catálogo de produtos por Seção — fonte de verdade que o bot principal também lê |
| `src/config/catalogo-x2/fotos/<secao>.zip` | Fotos publicadas (visíveis na busca do painel do bot) |
| `~/.x2-rildon-scraper/chrome-profile/` | Perfil do Chrome com login salvo (fora do projeto/OneDrive de propósito) |
| `~/.x2-rildon-scraper/progress/<secao>.json` | Progresso do download de fotos, por Seção |
| `~/.x2-rildon-scraper/rotinas.json` | Rotinas agendadas |
| `~/.x2-rildon-scraper/estoque/` | CSVs de Relatório de Estoque exportados + índice de lançamentos legado |
| `~/.x2-rildon-scraper/painel-produtos/historico.json` | Histórico de snapshots de Divergências/Situação/Qualidade |
| `~/.x2-rildon-scraper/lancamentos-x2/` | Capturas de Lançamentos (via tela oficial do X2) + planilhas .xlsx |
| `~/.x2-rildon-scraper/cortes-produtos/` e `.../curva-abc-parados/` | Últimas capturas dos alertas de WhatsApp (backend, mesmo sem tela) |

Tudo fora do projeto (`~/.x2-rildon-scraper/`) é de propósito: não é informação que precisa estar versionada no git nem sincronizada pelo OneDrive.

## Como isso conversa com o bot principal

Sempre que um script precisa que o bot Rildon (o processo dentro do Docker) saiba de uma mudança na hora — catálogo atualizado, recarregar cache de estoque — ele chama a própria API HTTP do bot em `http://localhost:<PORT>` com `Authorization: Bearer <API_TOKEN>` (mesmo token do `.env`, endpoint já existente, tratado como "Integração API" privilegiada em `access-control.js`). Esse é o único canal de comunicação entre os dois processos — nunca acesso direto a banco nem `docker exec` para isso (a exceção é a importação de estoque em si, que não depende de nenhuma sessão viva, então pode rodar via `docker exec`).

O campo `fabricante` de cada produto (usado pelo PDF por fabricante do pipeline de Lançamentos) não existe como dado bruto no X2 — é derivado pelo bot, na hora de indexar, a partir do padrão de texto do campo `nome` (ex: "... - MARFLEX - 7466"). Isso significa que produtos cadastrados pelo `x2-catalogo-sync.js` já saem com fabricante identificável automaticamente, sem nenhum código extra neste lado.

## Configuração (`.env`)

| Variável | Pra quê |
|---|---|
| `X2_USUARIO` / `X2_SENHA` | Login automático do X2 em rotinas agendadas (sem isso, rotina falha com erro claro em vez de travar esperando clique) |
| `API_TOKEN` | Autenticação do painel/scripts contra a API do bot Rildon (catálogo, estoque, WhatsApp, buscar-codigo) |
| `ALERTA_WHATSAPP_NUMERO` | Número de destino padrão dos alertas de Cortes/Parados |
| `GOOGLE_DRIVE_CREDENCIAIS_PATH` / `GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID` | Conta de serviço + pasta única do Drive, usadas pelo passo 5 do pipeline de Lançamentos |
| `X2_PAINEL_PORT` | Porta do painel (opcional, padrão 4123) |

## Estado atual — o que está ligado, pendente ou legado

- **Alertas de WhatsApp removidos da tela** (2026-09-11, pedido do usuário — "focar apenas nas rotinas e atualizações de cadastros"). O backend (rotas `/api/alertas/...`, os dois scrapers, `x2-whatsapp-alerta.js`, os tipos de rotina `cortes-produtos`/`produtos-parados`) continua intacto e funcional — só não tem mais botão nem dropdown pra criar rotina nova desse tipo. Se já existir uma rotina configurada desses tipos, ela continua rodando e mandando WhatsApp no horário normalmente.
- **PDF + Drive**: código completo e commitado, mas a conta de serviço do Google ainda não foi configurada (`GOOGLE_DRIVE_CREDENCIAIS_PATH`/`GOOGLE_DRIVE_PASTA_LANCAMENTOS_ID` vazios) — até lá, os passos 3 e 4 do pipeline rodam normalmente e o passo 5 só avisa no log e não faz nada.
- **`x2-painel/lancamentos.js` + rota `GET /api/lancamentos`**: código legado, não usado pela tela atual (a aba "Lançamentos" chama só as rotas `/api/lancamentos-x2/...`). Mantido por segurança, mas é candidato a remoção numa faxina futura.
- **Scripts nunca validados com automação real ponta a ponta**: `x2-estoque-export.js`, `x2-painel-produtos-snapshot.js`, `x2-cortes-produtos-scraper.js` e `x2-curva-abc-parados-scraper.js` tiveram seus seletores confirmados ao vivo (inspeção manual/JS no Chrome do usuário), mas o fluxo 100% automatizado via Playwright (login sozinho + navegação sem clique humano) ainda não foi visto rodando numa rotina agendada de verdade. Primeira rodada de cada um deveria ser observada, não só disparada e esquecida.
- **Painel reorganizado** (2026-09-11): CSS/JS extraídos de `index.html` para `style.css`/`app.js`; aba "Estoque" ganhou/perdeu a seção de Alertas (ver acima); aviso da aba Lançamentos atualizado para mencionar os 3 passos do pipeline.
- **Ajustes de usabilidade em "Atualizar Fotos"** (2026-09-11): campo "Só estes códigos" pra baixar foto de produto(s) específico(s) sem rodar a Seção inteira; tooltip da coluna "Publicados" corrigido (não fala mais em "rodar Montar zip" como passo manual — isso já era automático, só o texto estava desatualizado).
- **Frequência "a cada N horas" nas Rotinas** (2026-09-11): pensada originalmente pro Estoque (preço/estoque atualizado de 5 em 5h), mas ficou genérica — qualquer tipo de rotina pode usar.
