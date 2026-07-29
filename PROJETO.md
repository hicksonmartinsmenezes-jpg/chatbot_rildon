# Rildon Eletropeças — Bot WhatsApp: Documentação Completa

> **Leia isto antes de qualquer mudança.** Este arquivo é a fonte de verdade sobre arquitetura,
> decisões de design e armadilhas do projeto. Atualizado sempre que algo relevante mudar.

---

## 1. Visão Geral

Bot de atendimento WhatsApp para a **Rildon Eletropeças** (Aracaju/SE) — loja especializada em
**peças elétricas AUTOMOTIVAS** (não residencial). Fundada em 1991, atende linha leve, pesada
(caminhões/ônibus) e agrícola.

**Finalidade do bot:**
- Receber solicitações de orçamento e criar tickets para os atendentes humanos
- Encaminhar reclamações / solicitações à gestão
- Pedidos de crediário/financiamento são direcionados pro telefone direto do
  setor via "Outros Contatos" (o bot tinha um fluxo próprio de crediário —
  descontinuado em 2026-07-24, decisão do usuário)
- Responder dúvidas simples via IA (Groq/Gemini) quando a pergunta não se encaixa no menu
- Cliente típico: mecânico, eletricista automotivo ou motorista. **Prefere clicar em números**, não digita texto livre.

**Contato da loja:** (79) 99135-3569 | vendas@rildoneletro.com.br | Av. Chanceler Osvaldo Aranha, 151 — Novo Paraíso, Aracaju/SE
**Horário:** Seg–Sex 07:50–17:50 | Sáb 08:00–12:00 | Dom fechado

---

## 2. Stack Tecnológica

| Camada | Tecnologia |
|---|---|
| WhatsApp | `@whiskeysockets/baileys` |
| Backend | Node.js, Express.js, Socket.io |
| Banco de dados | PostgreSQL (Docker named volume `auth_info`) |
| IA | Groq `llama-3.1-8b-instant` (padrão) ou Gemini `gemini-2.5-flash` |
| Deploy | Docker + WSL2 |

**Variáveis de ambiente críticas (`.env`):**

```
AI_PROVIDER=groq          # "groq" ou "gemini"
GROQ_API_KEY=...
GEMINI_API_KEY=...
TZ_NEGOCIO=America/Maceio
MAX_CHARS_INPUT=500
```

**Comandos principais:**
```bash
node test-flow.js                   # roda todos os 97 testes (SEMPRE antes de commitar)
node test-flow.js --suite vendas    # roda só a suite de vendas
docker compose up --build -d        # sobe o bot em produção
```

---

## 3. Estrutura de Arquivos

```
bot/
├── src/
│   ├── flows/
│   │   ├── main.flow.js          ← roteamento central, menu, IA fallback
│   │   ├── vendas.flow.js        ← fluxo de orçamento (nome→veículo→produto)
│   │   ├── financeiro.flow.js    ← NÃO importado pelo main — arquivo legado
│   │   ├── suporte.flow.js       ← NÃO importado pelo main — arquivo legado
│   │   └── messages.js           ← TODAS as mensagens do bot (fonte única da verdade)
│   ├── services/
│   │   ├── ai.service.js         ← integração Groq/Gemini, rate limiter, cache
│   │   ├── botConfig.service.js  ← configurações do bot (iaAtiva, timeouts, etc.)
│   │   ├── humanMode.service.js  ← controle de modo humano por userId (in-memory)
│   │   ├── session.service.js    ← sessões (in-memory + PostgreSQL)
│   │   ├── ticket.service.js     ← criação de tickets no banco
│   │   ├── notificacao.service.js← notifica atendentes via Socket.io
│   │   └── ...outros services
│   ├── config/
│   │   └── empresa.js            ← base de conhecimento: produtos, marcas, FAQ, instruções
│   └── utils/
│       ├── validators.js         ← sanitizarTexto, normalizar, validarNome, validarCPF
│       └── horario.js            ← estaEmHorarioDeAtendimento(), mensagemForaDeHorario()
├── training/
│   ├── 00_atendimento.txt        ← carregado PRIMEIRO (ordem alfabética) — tom + Q&A
│   └── precos_indicativos.txt    ← faixas de preço para respostas da IA
├── test-flow.js                  ← 97 testes automatizados (sem WhatsApp/DB real)
└── PROJETO.md                    ← este arquivo
```

---

## 4. Menu Principal (estado atual)

```
Olá! Seja bem-vindo à Rildon Eletropeças.

1 - Orçamento / Falar com atendente
2 - Outros Contatos
3 - Horário e Localização
```

### Comportamento de cada opção

| Opção | O que faz |
|---|---|
| **1** | Entra direto no formulário de orçamento. Se o cliente já tem nome salvo (tickets anteriores), pula para "qual veículo?". Caso contrário pede nome. |
| **2** | "Outros Contatos" — mensagem estática com telefones diretos (RH, Crediário, Garantia, Ouvidoria). Sem sector/sessão. |
| **3** | Mostra horário de atendimento + endereço (resposta estática). |
| **IA** | Qualquer texto que não seja número 1–3 ou palavra-chave vai para a IA. A IA responde e pode rotear para um setor via `intencao`. |

**Atendente humano direto** (sem opção de menu): só acessível via IA com `intencao: "atendente"`.

---

## 5. Arquitetura dos Flows

### `main.flow.js` — Roteador Central

Ordem de processamento (importante — não reordenar):

1. Busca nome do cliente no histórico/tickets (se sessão vazia)
2. Verifica se a mensagem é uma consulta de protocolo (`#XXXX-XXXX`)
3. Verifica `PALAVRAS_ENCERRAR` → encerra atendimento
4. Verifica `PALAVRAS_MENU` → limpa sessão e mostra menu
5. Sanitiza sector/step inválido (ver armadilhas abaixo)
6. Roteia para `vendasFlow` se `session.sector === "vendas"`
7. Trata fluxo de atendente inline (sector `"atendente"`)
8. Switch 1–3 do menu principal
11. **Default → IA** (perguntarIA → roteia por `intencao`)

```
PALAVRAS_MENU    = { "0", "menu", "inicio", "voltar", "home", "cancelar",
                     "oi", "ola", "opa", "bom dia", "boa tarde", "boa noite" }

PALAVRAS_ENCERRAR = { "encerrar", "encerramento", "fechar", "finalizar",
                      "sair", "tchau", "bye" }

SECTORS_VALIDOS  = { "vendas", "atendente" }
```

### `vendas.flow.js` — Orçamento

```
aguardando_nome  →  aguardando_veiculo  →  aguardando_orcamento  →  [cria ticket]
```

- Se `session.customerName` já existe ao entrar pela opção 1, pula direto para `aguardando_veiculo`
- Aceita "pular" na etapa de veículo
- ESCAPE em qualquer etapa: `{ "0", "menu", "voltar", "cancelar", "inicio" }` → retorna `null` (main exibe menu)
- Ticket gerado com `type: "orcamento"`, sector sem setor explícito

> **Crediário descontinuado (2026-07-24)**: existia um `crediario.flow.js`
> com sub-menu próprio (solicitar/consultar/falar com financeiro), removido
> por decisão do usuário. Pedidos de crediário agora só recebem o telefone
> direto do setor via `MSG.outrosContatos.LISTA()` — não criam mais ticket
> nem sessão.

### Fluxo de Gestão (inline em `main.flow.js`)

```
aguardando_nome  →  aguardando_motivo_gestao  →  [cria ticket type: "atendimento_gestao"]
```

### Fluxo de Atendente (inline em `main.flow.js`)

Só entra aqui via IA com `intencao: "atendente"`:
```
aguardando_motivo_atendente  →  [cria ticket type: "atendente_humano"]
```

---

## 6. Sessões e Estado

### Como funcionam as sessões

- **In-memory** (`sessions{}` no `session.service.js`) + backup em PostgreSQL
- `getSession(userId)` retorna `{ sector: "main" }` como padrão para usuários novos

⚠️ **ARMADILHA CRÍTICA**: `"main"` é o valor padrão de `sector`, **não é um setor real**.
Nunca rotear para um flow baseado em `sector === "main"`. Sempre tratar "main" como "sem setor".

```js
// CORRETO — no main.flow.js:
if (session.sector && session.sector !== "main") {
  // verifica se o sector é válido
}

// ERRADO — quebraria tudo:
if (session.sector) {
  // "main" passaria aqui e seria tratado como setor inválido
}
```

### Campos relevantes da sessão

| Campo | Tipo | Uso |
|---|---|---|
| `sector` | string | Setor atual: `"vendas"`, `"atendente"` (ou `"main"` = nenhum) |
| `step` | string | Etapa atual dentro do setor |
| `customerName` | string | Nome do cliente (persistido entre tickets) |
| `veiculo` | string | Veículo informado no fluxo de orçamento |
| `aiHistorico` | array | Histórico de mensagens para contexto da IA (máx 20 entradas = 10 pares) |
| `_iaFalhas` | number | Contador de falhas consecutivas da IA (reset em sucesso) |

---

## 7. Serviço de IA (`ai.service.js`)

### Provedores

| Provedor | Modelo | Rate limit | `intervalMs` |
|---|---|---|---|
| Groq (padrão) | `llama-3.1-8b-instant` | 6000 TPM free | 20000ms |
| Gemini | `gemini-2.5-flash` | 10 req/min free | 6500ms |

Trocar provedor: `AI_PROVIDER=gemini` no `.env`.

### JSON esperado da IA

```json
{ "resposta": "texto da resposta", "intencao": "chat" }
```

### Intenções e roteamento

| `intencao` | Quando usar | O que main.flow.js faz |
|---|---|---|
| `"chat"` | **Padrão** — saudações, dúvidas técnicas, fora do escopo | Retorna só a resposta da IA |
| `"vendas"` | Intenção CLARA de comprar ou pedir orçamento ("preciso de X", "tem X?", "quanto custa") | Exibe resposta + `MSG.vendas.MENU()` |
| `"atendente"` | Pede EXPLICITAMENTE falar com humano/atendente/vendedor | Seta sector atendente, pede motivo |
| `"gestao"` | Reclamação grave, insatisfação forte, pede gerente/gestor; ou menciona crediário, parcelamento, financiamento (2026-07-24) | Exibe resposta + `MSG.outrosContatos.LISTA()` (telefones diretos, sem sector/sessão) |

⚠️ **IMPORTANTE**: `"vendas"` exige intenção CLARA de compra. Dúvidas técnicas gerais → `"chat"`.
Evite sobrecarregar com `"vendas"` — o cliente fica preso num formulário quando só queria tirar dúvida.

### Cache do system prompt

- TTL de **3 minutos** para o bloco base (empresa + treinamento)
- Nome do cliente e contexto de horário são injetados dinamicamente **por chamada** (não cacheados)
- Training: arquivos carregados em ordem **alfabética**, limitados a **5000 chars** (~1250 tokens)
- Nomear com `00_` garante que o arquivo carrega primeiro dentro do limite

### `getBotConfig().iaAtiva`

⚠️ **ARMADILHA**: a IA deve ser **ativa por padrão**. O campo `iaAtiva` em `botConfig.service.js`
deve ser `bot.iaAtiva !== false` — não `!!bot.iaAtiva` (que seria falso quando undefined).

```js
// CORRETO:
iaAtiva: bot.iaAtiva !== false,  // undefined → true (ativo)

// ERRADO:
iaAtiva: !!bot.iaAtiva,          // undefined → false (IA nunca chamada!)
```

---

## 8. Arquivos de Treinamento

### `training/00_atendimento.txt` (carrega PRIMEIRO)
- Tom e estilo de atendimento
- 12 pares de P&R para situações comuns
- Situações específicas: mecânicos, desconto, elétrica residencial, dúvidas técnicas, reclamações

### `training/precos_indicativos.txt`
- Faixas de preço para motores de partida, alternadores, lâmpadas, sensores, cabos, interruptores

### Como adicionar novos arquivos de treinamento
1. Crie `training/nome_do_arquivo.txt`
2. Para prioridade de carregamento, use prefixo numérico: `01_produtos.txt`, `02_marcas.txt`
3. Mantenha o total de todos os arquivos **abaixo de 5000 chars** ou o conteúdo será truncado
4. Arquivos começando com `_` são ignorados (útil para rascunhos)

---

## 9. Validadores (`utils/validators.js`)

| Função | O que faz |
|---|---|
| `sanitizarTexto(texto, limite)` | Remove chars de controle, trim, limita a `MAX_CHARS_INPUT` (500) |
| `normalizar(str)` | trim + lowercase + remove acentos (NFD). **Usar em todos os pontos de decisão** |
| `validarNome(nome)` | Aceita nome único ≥3 chars (ex: "Marcos", "Cher") ou 2+ partes |
| `validarCPF(cpf)` | Valida dígitos verificadores + rejeita sequências repetidas |
| `validarTamanho(texto, min, max)` | Retorna `{ ok, erro: "minimo"|"maximo" }` |

**Padrão de uso nos flows:**
```js
const msg          = normalizar(sanitizarTexto(message));       // para decisões
const msgSemPontos = msg.replace(/[^\p{L}\p{N}\s]/gu, "").trim(); // para keywords com pontuação
```

---

## 10. Messages (`flows/messages.js`)

Fonte única da verdade para todas as strings exibidas ao cliente.
**Nunca colocar mensagens inline nos flows** — sempre usar `MSG.xxx`.

Estrutura atual:
```js
MSG.VOLTAR_MENU          // "\n_Digite *0* para voltar ao menu._"
MSG.ESCAPE_DICA          // "\n_Digite *0* a qualquer momento para voltar ao menu._"
MSG.NOME_INVALIDO        // mensagem de erro para nome inválido
MSG.CPF_INVALIDO         // mensagem de erro para CPF inválido
MSG.NAO_INFORMADO        // "Não informado" (usado em tickets)
MSG.vendas.MENU()        // Intro da seção de orçamento (sem numeração)
MSG.vendas.PEDIR_NOME    // "Para solicitar orçamento, informe seu nome completo:"
MSG.vendas.PEDIR_VEICULO // "Informe o veículo (marca, modelo e ano):"
MSG.vendas.PEDIR_ORCAMENTO // "Descreva o produto ou peça que precisa:"
MSG.vendas.ORCAMENTO_SOLICITADO(ticket) // Confirmação com protocolo
MSG.outrosContatos.LISTA() // Telefones diretos (RH, Crediário, Garantia, Ouvidoria) — sem sector/sessão
MSG.gestao.PEDIR_NOME    // "Para registrar sua solicitação, informe seu nome completo:"
MSG.gestao.PEDIR_MOTIVO  // "Descreva o motivo pelo qual deseja falar com a gestão:"
MSG.gestao.REGISTRADO(ticket) // Confirmação com protocolo
MSG.main.PEDIR_MOTIVO_ATENDENTE // "Descreva brevemente o que precisa:"
MSG.main.ATENDENTE_HUMANO(ticket) // Confirmação de atendente humano
```

---

## 11. Testes (`test-flow.js`)

**97 testes** organizados em 7 suites. Roda sem WhatsApp, sem banco real e sem IA real.

| Suite | O que testa |
|---|---|
| `menu` | Reconhecimento de palavras-chave, opções 1–4, cliente retornando com nome salvo |
| `vendas` | Fluxo completo de orçamento, validação de nome, escape em cada etapa |
| `crediario` | Sub-menu, validação de CPF, opções 1/2/3, escape |
| `atendente` | Roteamento por IA com `intencao: "atendente"`, coleta de motivo |
| `ia` | Intenções da IA, fallback por falha, fallback após 2 falhas consecutivas |
| `edge` | Sector inválido, step corrompido, mensagens vazias, sector "main" |
| `posfluxo` | Sequência completa: orçamento → menu → crediário → gestão |

**Mocks:**
- PostgreSQL: in-memory simples (sessions, tickets, history, settings)
- IA: `_iaMockFn` sobreponível por teste para simular intenções específicas
- `getBotConfig`: retorna `{ iaAtiva: true, timeoutAviso: 7, timeoutEncerramento: 15 }`
- `humanMode`: sempre retorna `estaAtivo = false`
- `notificacao`: silencioso (não envia nada)

**Regra de ouro:** sempre rodar `node test-flow.js` antes de commitar.

---

## 12. Armadilhas Conhecidas (leia antes de mudar qualquer coisa)

### 1. `sector: "main"` não é um setor real
`getSession()` retorna `{ sector: "main" }` como padrão. "main" não é um setor real —
é o valor inicial. Toda lógica de setor deve ter `sector !== "main"`.

Em especial, a busca de nome do cliente retornando **exige** essa checagem:
```js
// CORRETO — reconhece clientes de retorno:
if (!nomeSalvo && (!session.sector || session.sector === "main")) {
    const nomeHistorico = await _buscarNomeCliente(userId);
}

// ERRADO — !session.sector é sempre false porque sector = "main" (truthy):
if (!nomeSalvo && !session.sector) { ... }  // nunca executa!
```

### 2. `getBotConfig().iaAtiva` deve defaultar para `true`
Ver seção 7. Se esquecer o `!== false`, a IA nunca é chamada e o bot só responde "Não entendi".

### 3. Arquivos de treinamento são limitados a 5000 chars
O bloco inteiro (`parts.join("\n\n")`) é cortado em 5000. Prefixar com `00_` garante prioridade.

### 4. `financeiro.flow.js` e `suporte.flow.js` existem mas NÃO são importados
`main.flow.js` importa só `vendas.flow` e `crediario.flow`. Os outros são arquivos legados.
Se precisar deles no futuro, adicione o import e o roteamento explicitamente.

### 5. `normalizar()` usa NFD + unicode range
```js
.normalize("NFD").replace(/[̀-ͯ]/g, "")
```
Esse range hex é equivalente ao `̀-ͯ` — não alterar sem testar acentos portugueses.

### 6. Rate limiter da IA é 20s para Groq
Com ~1600 tokens por request (prompt expandido + resposta), o limite free é ~3 req/min.
`intervalMs: 20000` dá margem segura. Não reduzir sem aumentar o tier do plano.

### 7. Git rebase pode destruir arquivos
Em sessões anteriores, um `git rebase --abort` falhou parcialmente e reverteu o working tree
para um commit antigo, deletando arquivos criados nessa sessão. Sempre commitar antes de
qualquer operação destrutiva de git. Em caso de desastre, os arquivos críticos estão neste doc.

### 8. Atendente não tem opção direta no menu
A opção "Falar com Atendente" foi removida do menu (era redundante com opção 1).
O setor `"atendente"` só é acessível via IA com `intencao: "atendente"`.
Os testes que testam atendente devem usar mock de IA, não `enviar("2")`.

### 9. Horário do sábado: 08:00 (não 07:50)
`estaEmHorarioDeAtendimento()` usa `8*60` para sábado. Todos os textos exibidos ao cliente
dizem "08:00". Qualquer alteração nessa função deve manter consistência com `empresa.js`
e com a opção 4 do menu.

### 10. A loja TAMBÉM vende mecânica (filtros, freios, suspensão)
A instrução 0 de `empresa.js` e o system prompt da IA mencionam mecânica geral.
Não diga ao cliente que a loja só tem elétrica — isso é incorreto.
Perguntas sobre filtros/freios devem ser classificadas como `intencao: "vendas"`.

---

## 13. Empresa — Dados para Configuração

Todos os dados estão em `src/config/empresa.js`. Editar lá para manter consistência.

**Produtos principais:** alternadores, motores de partida, lâmpadas, fusíveis, velas, bobinas,
sensores, faróis, buzinas, palhetas, cabos, interruptores, relés, bombas de combustível,
motores auxiliares, baterias/acessórios, alarmes, kits reboque, discos tacógrafo, químicos.

**Marcas:** OSRAM, Gauss, ZM, SEG Automotive, Kostal, Bosch, Denso, Wega, Delco Remy, Lucas,
MTE, ASX, Olimpic, Bobinauto, Prima Parts, Fiamm, Neolux, Contactsul, TC Chicotes, Ikro,
Marflex, DNI, Cemak, Eletricway, KTR, AMS.

**NÃO trabalhamos com:** elétrica residencial/industrial (disjuntores de painel NBR, tomadas,
eletrodutos). Se o cliente perguntar sobre isso, orientar a procurar loja de materiais elétricos.

---

## 14. Fluxo de Tickets

Todo ticket criado tem:
- `userId`: número WhatsApp
- `type`: `"orcamento"` | `"crediario"` | `"consulta_crediario"` | `"atendente_financeiro"` | `"atendente_humano"` | `"atendimento_gestao"`
- `sector`: `"financeiro"` | `"gestao"` | `"atendimento"`
- `customerName`: nome informado pelo cliente
- `description`: texto livre com detalhes
- `protocolo`: gerado automaticamente (`YYYY-XXXX`)

Após criar o ticket, `notificarAtendente(ticket)` dispara via Socket.io para o painel.

---

## 15. Próximas Melhorias Sugeridas

Estas melhorias foram identificadas mas ainda não implementadas:

1. **Crediário UX**: o flow atual pergunta nome + CPF + descrição, mas não há feedback de prazo claro.
   Melhorar `MSG.crediario.SOLICITACAO_REGISTRADA` com prazo esperado de retorno.

2. **Horário inteligente no menu**: `menuPrincipal()` exibe 🟢/🔴, mas poderia mostrar
   "Voltamos segunda-feira às 07:50h" quando fora do horário — `proximoAtendimento()` já existe em `horario.js`.

3. **Mais arquivos de treinamento**: produtos específicos por linha (pesada, agrícola),
   tabela de aplicações (qual alternador para qual carro).

4. **`MSG.vendas.CONSULTOR`**: existe em `messages.js` mas é código morto — não é chamado
   por nenhum flow. Remover ou documentar intenção futura.

5. **Admin panel**: revisão dos timeouts de sessão (atualmente 7/15 min via `botConfig`).

---

## 16. Como Trabalhar Neste Projeto com uma Nova IA

### Antes de começar qualquer mudança:
1. Leia este arquivo inteiro
2. Rode `node test-flow.js` para confirmar que tudo está verde (97/97)
3. Leia o arquivo que vai modificar com a ferramenta Read

### Ao modificar flows:
- Sempre atualize `messages.js` se adicionar/alterar mensagens
- Sempre atualize os testes em `test-flow.js` se mudar comportamento esperado
- Rode os testes depois de qualquer mudança

### Ao adicionar nova opção de menu:
1. Adicione o `case` no switch de `main.flow.js`
2. Atualize o texto do `menuPrincipal()` em `main.flow.js`
3. Atualize o texto de fallback da IA (bloco de 2 falhas consecutivas) em `main.flow.js`
4. Atualize o texto do `MSG.vendas.MENU()` em `messages.js` se relevante
5. Adicione testes na suite `menu` e na suite `posfluxo`

### Ao modificar a IA:
- Teste com `--suite ia` especificamente
- Cuidado com as intenções: "vendas" deve ser **só para intenção clara de compra**
- Não reduza o `intervalMs` do Groq abaixo de 20s sem mudar o plano

### Commit antes de sair:
```bash
git add -A && git commit -m "descrição do que foi feito"
```

---

*Última atualização: gerado automaticamente pela IA de desenvolvimento após refatoração do menu (remoção do submenu de vendas, remoção de "Falar com Atendente" como opção direta, renomeação de "Reclamação" para "Falar com a Equipe").*
