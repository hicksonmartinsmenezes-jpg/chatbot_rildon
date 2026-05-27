# ⚡ Chatbot Rildon Eletropeças v6

Chatbot WhatsApp sem API paga — Baileys + Node.js + JSON persistido em disco.

## ✅ O que há de novo na v6.1 (correções)

- 🔒 `ler()` agora usa mutex — leituras nunca ocorrem durante uma escrita
- 💾 Escrita atômica via `.tmp` + rename — arquivo nunca fica corrompido em caso de crash
- 🎫 Protocolo de ticket usa contador dedicado — sem colisão ao deletar tickets ou em concorrência
- ⚠️ Aviso explícito sobre limitações do PM2 cluster mode (veja abaixo)

## ⚠️ PM2 — Fork mode vs Cluster mode

| Modo | Funciona? | Observação |
|------|-----------|------------|
| `fork` (padrão) | ✅ Sim | 1 processo, restart automático. Recomendado. |
| `cluster` | ⚠️ Parcial | Múltiplos workers com memória separada. Sessões e mutex **não são compartilhados** entre workers. Um usuário pode perder contexto se cair em workers diferentes. |

**Recomendação:** use `fork` mode com PM2. Se precisar de múltiplos workers, migre sessões para Redis e banco para SQLite (`better-sqlite3`).

```ini
# ecosystem.config.js recomendado
module.exports = {
  apps: [{
    name: "chatbot-rildon",
    script: "src/server.js",
    instances: 1,          // fork mode — NÃO use "max" com esta implementação
    autorestart: true,
    watch: false,
    env: { NODE_ENV: "production" }
  }]
};
```

## 🚀 Como instalar

```bash
npm install
cp .env.example .env
# Edite o .env com o número do atendente e API_TOKEN
npm run dev
```

Escaneie o QR Code que aparecer no terminal com o WhatsApp.

## 🌐 Painel web

Acesse: http://localhost:3000

## 📁 Estrutura

```
src/
├── config/whatsapp.js         # Conexão Baileys
├── flows/                     # Fluxos de conversa
├── services/
│   ├── db.service.js          # JSON + Mutex + escrita atômica
│   ├── message.service.js     # Processa mensagens (com fila)
│   ├── session.service.js     # Sessões + timeout de inatividade
│   ├── ticket.service.js      # CRUD tickets (contador atômico)
│   ├── history.service.js     # Histórico
│   ├── notificacao.service.js # Notifica atendente no WhatsApp
│   └── queue.service.js       # Fila de mensagens por usuário
├── utils/
│   ├── validators.js          # Validação CPF e nome
│   └── horario.js             # Horário de atendimento
frontend/                      # Painel web
```
