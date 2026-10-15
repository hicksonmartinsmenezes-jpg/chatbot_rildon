# Arquitetura do Frontend Rildon

Esta versão iniciou a separação dos arquivos maiores sem alterar a lógica principal do painel.

## Organização aplicada

- `js/campaigns/campaigns-render.js`: helpers e renderização da tabela de campanhas.
- `js/conversations/conversations-utils.js`: utilitários puros da tela de conversas.

## Próximos passos seguros

1. Separar chamadas de API em arquivos `*-api.js`.
2. Separar renderização de HTML em arquivos `*-render.js`.
3. Manter os arquivos principais como orquestradores de fluxo.
4. Evitar mudar comportamento visual sem teste no navegador.

## Regra de manutenção

Arquivos principais devem ficar menores e mais fáceis de ler. Funções puras e renderizações grandes devem ir para módulos auxiliares.

## v17 — Segunda etapa de separação

Nesta etapa foram separados módulos auxiliares de baixo risco:

- `js/tickets/tickets-render.js`: renderização e delegação de ações dos cards de atendimento.
- `js/contacts/contacts-utils.js`: formatação de telefone, iniciais, cores e status de contatos.
- `js/history/history-utils.js`: filtros, resumo e estados vazios do histórico.

A regra mantida foi preservar as funções globais existentes para não quebrar o painel atual.

## v18 — Correção fina e separação adicional

- Adicionado `js/conversations/conversations-render.js` para concentrar botões/ações do cabeçalho de conversas.
- Adicionado `js/campaigns/campaigns-modal.js` para isolar o modal de ações das campanhas.
- Botões gerados dinamicamente agora recebem `type="button"`, evitando submits acidentais quando renderizados dentro de formulários.
- Mantida compatibilidade com as funções globais existentes para reduzir risco de regressão.
