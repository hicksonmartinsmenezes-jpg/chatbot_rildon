# Melhorias aplicadas — limpeza e estabilidade do backend

## Correções aplicadas

- Removida a pasta duplicada `src/backend`, que continha cópias antigas e podia causar confusão em deploy/manutenção.
- Removidos logs reais (`access.log`, `error.log`, `info.log`, `warn.log`) do pacote.
- Removidos JSONs de runtime (`auth_sessions.json`, `sessions.json`, `tickets.json`, `history.json`, `tickets_contador.json`).
- Removidos uploads reais de campanhas e perfis.
- Mantidas pastas necessárias com `.gitkeep`.
- Adicionado `.gitignore` para evitar que logs, sessões, uploads e `.env` voltem ao pacote.
- Validada sintaxe dos arquivos JavaScript.

## Observação

Este pacote enviado contém backend, não frontend/CSS. Para melhorias visuais, responsividade e tema, enviar também a pasta `frontend/css`.
