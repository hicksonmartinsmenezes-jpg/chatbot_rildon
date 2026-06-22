# Rildon — verificação e correções v8

## Correções confirmadas
- Auto-registro de contatos usa cast explícito no PostgreSQL para evitar:
  `inconsistent types deduced for parameter $2`.
- `/api/contacts/photo` retorna 204 quando a foto não existe, evitando erro visual.
- Envio manual e mídia priorizam `@lid` quando há mapeamento, reduzindo o caso "Aguardando mensagem".
- `message.ogg` e `ticket.ogg` não retornam mais 404 quando o frontend solicitar sons ausentes.
- Estrutura duplicada `src/backend` removida.
- Logs, JSONs de runtime e uploads reais removidos do pacote.

## Observação
Mensagens antigas já exibidas como "Aguardando mensagem" no WhatsApp não são recuperáveis pelo sistema.
O teste correto é enviar uma nova mensagem após rebuild.
