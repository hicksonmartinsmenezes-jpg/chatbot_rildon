# Backend - preparação inicial para produção

Esta versão foi limpa para reduzir riscos antes de subir para GitHub/servidor.

## O que foi aplicado

- Removida a pasta duplicada `src/backend/`.
- Mantida a estrutura principal em `src/`.
- Removidos dados locais JSON, logs e uploads reais do pacote.
- Mantidos diretórios necessários com `.gitkeep`.
- Criado `.gitignore` para evitar versionar `.env`, logs, dados locais, uploads e sessões.
- Criado `.env.example` com variáveis esperadas pelo backend.
- Criado `package.json` com scripts básicos de execução, desenvolvimento, migration e teste de banco.

## Como rodar em uma máquina nova

```bash
npm install
cp .env.example .env
# edite o .env com senhas, banco e número do atendente
npm run migrate
npm start
```

## Atenção antes de produção real

- Não use os valores de exemplo do `.env.example` em produção.
- Configure `CORS_ORIGIN` com o domínio real do painel.
- Use senha forte no PostgreSQL.
- Faça backup dos uploads/logs antigos antes de limpar o projeto local.
- As sessões do WhatsApp/Baileys devem ficar fora do Git.
