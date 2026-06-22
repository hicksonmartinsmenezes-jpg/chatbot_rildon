# Backend — Melhorias V3

## Objetivo
Rodada focada em estabilidade de produção, validação da V2 recebida e redução de riscos operacionais.

## Aplicado

### Segurança e permissões
- Mantidas as permissões de tickets/mensagens da V1/V2.
- Mantido WhatsApp reconnect restrito a admin/supervisor.
- Mantidas rotas críticas de contatos protegidas por usuário privilegiado.
- Adicionado rate limit específico para mensagens, uploads e ações críticas.

### Produção/observabilidade
- Adicionado `request-id` por requisição (`X-Request-Id`).
- Adicionado middleware global de erro em arquivo próprio.
- Adicionado handler 404 para API.
- Adicionados health checks:
  - `/health`
  - `/api/health`
  - `/api/ready`
  - `/api/live`

### Auditoria
- Mantida auditoria de contatos e WhatsApp.
- Adicionada auditoria para campanhas:
  - criar campanha
  - upload de mídia
  - iniciar campanha
  - cancelar campanha
  - retry de destinatários
  - excluir campanha
- Consolidada tabela `audit_logs` no `schema.sql`.

### Limpeza do pacote
- Removida estrutura duplicada `src/backend`.
- Removidos arquivos JSON de dados reais.
- Removidos arquivos `.log` reais.
- Removidos uploads reais do pacote.
- Adicionados `.gitkeep` nas pastas necessárias.
- Adicionado `.gitignore`.

### Configuração
- `JWT_SECRET` tornou-se opcional, pois o sistema atual usa sessão HttpOnly persistida no banco, não JWT.
- `API_TOKEN` continua obrigatório e forte para integrações.

## Validação executada
- `node --check` em todos os arquivos `.js`.
- Verificação de requires locais.
- Confirmação de ausência de `src/backend` duplicado.
- Confirmação de ausência de `.json` em `src/data`.
- Confirmação de ausência de `.log` em `src/logs`.
- Confirmação de ausência de uploads reais no pacote.

## Ainda recomendado antes de produção
- Testar login e fluxo completo em ambiente real.
- Testar envio manual, campanhas e WhatsApp reconnect.
- Conferir `.env.example`, `docker-compose.yml` e `package.json` no projeto completo, pois este ZIP não trouxe esses arquivos na raiz.
