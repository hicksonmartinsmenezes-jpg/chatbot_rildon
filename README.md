# ⚡ Chatbot Rildon Eletropeças v7

Chatbot WhatsApp sem API paga — Baileys + Node.js + PostgreSQL.

## ✅ O que há de novo na v7 (melhorias)

### 🔒 Segurança
- `.gitignore` reforçado: `auth_info/`, `src/uploads/profiles/`, `.env.*` e outros dados sensíveis explicitamente ignorados
- `sanitizarTexto()` em todos os campos de entrada livre — remove caracteres de controle antes de persistir
- Senha mínima de 4 caracteres e validação de formato de foto no perfil (já existia, mantido)
- `DB_PASSWORD` verificada na inicialização com aviso explícito se ausente

### 🎫 Protocolo atômico (sem colisão)
- Geração via `SELECT nextval('protocolo_seq')` no PostgreSQL
- Atomicidade garantida pelo banco — sem race condition mesmo com múltiplas requisições paralelas
- Formato mantido: `YYYY-NNNN` (ex: `2026-0001`)

### 💾 Sessões no PostgreSQL (tabela `sessions`)
- Sessões persistem reinicializações do servidor
- Cache em memória para leituras rápidas; escrita sempre vai ao banco (upsert)
- Limpeza automática de sessões inativas via TTL configurável (`SESSION_TTL_HORAS`, padrão: 24h)
- Compatível com PM2 fork mode e cluster mode (sessões compartilhadas via banco)

### 🗄️ PostgreSQL consolidado
- Pool configurável via `.env` (tamanho, timeouts)
- `verificarConexao()` na inicialização: servidor não sobe se o banco estiver inacessível
- `schema.sql` idempotente com `CREATE TABLE IF NOT EXISTS` e `CREATE SEQUENCE IF NOT EXISTS`
- Inicialização sequencial em `server.js`: banco → HTTP → WhatsApp

## ⚠️ PM2 — Fork mode vs Cluster mode

| Modo | Funciona? | Observação |
|------|-----------|------------|
| `fork` (padrão) | ✅ Sim | Recomendado. |
| `cluster` | ✅ Sim (v7) | Sessões no banco são compartilhadas entre workers. |

## 🚀 Como instalar

```bash
npm install
cp .env.example .env
# Edite o .env com suas configurações (banco, número, tokens)

# Criar banco e tabelas
psql -U postgres -c "CREATE DATABASE chatbot_rildon;"
psql -U postgres -d chatbot_rildon -f src/database/schema.sql

npm run dev
```

Escaneie o QR Code que aparecer no terminal com o WhatsApp.

## 🌐 Painel web

Acesse: http://localhost:3000

## 📁 Estrutura

```
src/
├── config/whatsapp.js         # Conexão Baileys
├── database/
│   ├── postgres.js            # Pool + verificarConexao()
│   └── schema.sql             # Tabelas + sequence protocolo_seq
├── flows/                     # Fluxos de conversa (main/suporte/vendas/financeiro)
├── services/
│   ├── session.service.js     # Sessões no PostgreSQL + cache em memória
│   ├── ticket.service.js      # Protocolo atômico via SEQUENCE
│   ├── message.service.js     # Processamento com fila e rate limit
│   └── ...
└── utils/
    ├── validators.js          # CPF, nome, tamanho + sanitizarTexto()
    └── horario.js             # Horário de atendimento por timezone
```

## 🔑 Variáveis de ambiente importantes

| Variável | Descrição | Padrão |
|---|---|---|
| `DB_HOST` | Host do PostgreSQL | `localhost` |
| `DB_PORT` | Porta | `5432` |
| `DB_USER` | Usuário | `postgres` |
| `DB_PASSWORD` | Senha (obrigatório) | — |
| `DB_NAME` | Nome do banco | `chatbot_rildon` |
| `DB_POOL_MAX` | Conexões no pool | `10` |
| `SESSION_TTL_HORAS` | Expirar sessões inativas após N horas | `24` |
| `ATENDENTE_NUMBER` | Número WhatsApp do atendente | — |
| `AVISO_MINUTOS` | Aviso de inatividade | `3` |
| `TIMEOUT_MINUTOS` | Encerramento por inatividade | `5` |
