# BOT_MELHORIAS_V15

## Objetivo
Reduzir risco operacional do fluxo WhatsApp → contato → ticket → mensagem → socket, com foco em dois pontos críticos:

1. separar parte do `src/config/whatsapp.js` em módulos auxiliares;
2. impedir perda de mensagens recebidas via `@lid` quando não for possível resolver imediatamente para `@s.whatsapp.net`.

## Alterações aplicadas

### 1. Novo módulo `src/whatsapp/lid-map.js`
Centraliza:

- normalização de JID;
- mapa `@lid → @s.whatsapp.net`;
- mapa reverso `@s.whatsapp.net → @lid`;
- persistência em `lid_map`;
- resolução de destino para envio manual;
- candidatos para foto de perfil.

### 2. Novo módulo `src/whatsapp/message-utils.js`
Centraliza:

- extração de texto;
- detecção de mídia;
- validação de mensagem de usuário;
- parsing de status de mensagem;
- unwrap de mensagens efêmeras/view once.

### 3. Correção importante do `@lid`
Antes, se uma mensagem chegasse por `@lid` sem mapeamento, ela podia ser ignorada.

Agora:

- tenta resolver via mapa;
- tenta resolver via `senderPn`;
- se não conseguir, mantém o próprio `@lid` como `userId`;
- salva/processa/responde usando `@lid`.

Isso evita mensagem “sumir” do painel.

### 4. Correção de envio manual
`resolveSendJid()` agora existe e fica centralizado no módulo de LID.

Se um número tiver `@lid` conhecido, o envio prioriza `@lid`, reduzindo risco de “Aguardando mensagem” no WhatsApp.

### 5. Contato automático mais resiliente
`autoRegisterContact()` agora também aceita fallback de `@lid`, salvando o identificador numérico enquanto o número real não for descoberto.

### 6. Banco/migration
Adicionada migration:

- `src/database/migrations/010_lid_map.sql`

E schema consolidado com `contacts` e `lid_map`.

## Validação

- JS validado sem erro de sintaxe;
- requires locais verificados, nenhum arquivo faltando;
- `src/backend` duplicado não existe neste pacote;
- logs/uploads reais não foram adicionados.
