# Bot — Melhorias v14

## Foco
Melhorias aplicadas no fluxo crítico:

WhatsApp → contato → ticket/histórico → resposta do bot → painel via Socket.IO

## Alterações aplicadas

### 1. Auto-registro de contatos mais robusto
- Substituído o `INSERT ... SELECT ... WHERE NOT EXISTS` por fluxo seguro com `SELECT` + `INSERT`/`UPDATE`.
- Mantidos casts explícitos no PostgreSQL.
- Evita o erro já visto em logs: `inconsistent types deduced for parameter`.
- Atualiza o nome do contato quando o contato existe apenas com nome genérico/número.
- Emite `contacts_updated` quando novo contato é criado automaticamente.

### 2. Melhor rastreabilidade do bot
- Logs mais claros:
  - `[MESSAGE_IN]`
  - `[CONTACT_CREATED]`
  - `[CONTACT_UPDATED]`
  - `[BOT_PROCESSING_ERROR]`
  - `[FLOW_ERROR]`

### 3. Timeout de processamento
- Adicionado `BOT_MESSAGE_TIMEOUT_MS` via `.env`.
- Padrão: 45 segundos.
- Evita mensagem ficar travada indefinidamente caso IA/fluxo demore demais.

### 4. Fallback amigável em erro
- Se o processamento do bot falhar, o cliente recebe uma mensagem amigável.
- Variáveis opcionais:
  - `BOT_PROCESSING_FALLBACK`
  - `BOT_FLOW_FALLBACK`

### 5. Presença de digitação
- O bot tenta enviar presença `composing` antes de processar a resposta.
- Isso melhora a percepção do cliente quando IA/fluxo demora alguns segundos.

### 6. Histórico preservado em erro de fluxo
- Se `mainFlow` falhar, o sistema salva histórico com setor `erro` e emite atualização para o painel.
- Antes, erros internos podiam ficar apenas no log e não aparecer claramente no painel.

## Validação
- `node --check` executado nos arquivos alterados.
- Auditoria completa de sintaxe executada em `src/**/*.js`.
- Sem erro de sintaxe JavaScript.

## Próximo passo recomendado
Testar com estes cenários:

1. Cliente novo envia mensagem.
2. Cliente existente envia mensagem.
3. Cliente com `@lid` envia mensagem.
4. IA/fluxo falha ou demora.
5. Atendimento humano ativo.
6. Mensagem de mídia sem legenda.
