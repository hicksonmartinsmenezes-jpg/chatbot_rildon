# Chatbot WhatsApp — Rildon Eletropeças

Bot de atendimento via WhatsApp com painel de administração. Stack: **Node.js + Baileys + PostgreSQL + Socket.io**.

---

## Configuração rápida

```bash
# 1. Copiar e preencher as variáveis de ambiente
cp .env.example .env
# edite .env com suas credenciais reais

# 2. Instalar dependências
npm install

# 3. Criar tabelas no banco
psql -U postgres -d chatbot_rildon -f src/database/schema.sql

# 4. Iniciar em desenvolvimento
npm run dev

# 5. Iniciar em produção
npm start
```

---

## Variáveis de ambiente obrigatórias

| Variável         | Descrição                                          |
|------------------|----------------------------------------------------|
| `API_TOKEN`      | Token Bearer para autenticação da API externa      |
| `JWT_SECRET`     | Segredo para assinar tokens de sessão do painel    |
| `DB_PASSWORD`    | Senha do PostgreSQL                                |
| `ATENDENTE_NUMBER` | Número WhatsApp que recebe notificações de tickets |

Gerar tokens seguros:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Melhorias aplicadas (v7 → v8)

### 🔴 Segurança
- **`.gitignore` completo**: `.env`, `auth_info/`, `src/backups/`, `src/logs/`, `src/data/` e `src/uploads/profiles/` nunca serão versionados
- **CSP habilitada**: `contentSecurityPolicy` do Helmet estava `false`. Agora tem política configurada via `CSP_CONNECT_SRC` no `.env`
- **SSL para PostgreSQL**: suporte a `DB_SSL=true` para conexões em produção (Heroku, Railway, Render)

### 🟡 Confiabilidade
- **Deduplicação persistente**: o `Set` em memória que deduplicava mensagens era perdido em cada restart. Agora usa a tabela `processed_messages` no PostgreSQL como segunda camada — mensagens recentes (últimas 24h) não são reprocessadas mesmo após reinicializações
- **Limpeza automática da tabela de dedup**: `setInterval` a cada 6h remove entradas antigas; evita crescimento indefinido
- **`main.flow.js` — switch usa `msgNorm`**: o switch anterior usava `message.trim()` sem normalização, causando falhas com entradas como `"4 "` (espaço extra) ou variações de acentuação. Agora usa a string já normalizada (`msgNorm`)

### 🟠 Escalabilidade
- **Rate limiter com abstração**: o objeto global `rateLimits` foi encapsulado em uma classe `MemoryRateLimiter` com interface documentada. Para migrar para Redis (necessário em múltiplas instâncias), basta criar `src/services/rateLimiter.redis.js` implementando os métodos `hit(userId)` e `cleanup()` e importar no lugar da implementação em memória

### 🔧 Manutenibilidade
- **`notificarSeDisponivel` exportado**: a função existia apenas como referência mas não estava no `module.exports`, causando erro em runtime. Agora exportada corretamente com semântica clara (fora do horário: registra mas não envia)
- **`schema.sql` atualizado**: tabela `processed_messages` adicionada com índice para limpeza eficiente

---

## Estrutura do projeto

```
src/
├── app.js              # Express, middlewares, rotas
├── server.js           # Inicialização sequencial (banco → backup → HTTP → WhatsApp)
├── config/
│   └── whatsapp.js     # Conexão Baileys, reconexão, deduplicação
├── database/
│   ├── postgres.js     # Pool de conexões, dedup helpers
│   └── schema.sql      # DDL completo
├── flows/              # Lógica de conversação por setor
│   ├── main.flow.js
│   ├── suporte.flow.js
│   ├── vendas.flow.js
│   ├── financeiro.flow.js
│   └── messages.js
├── services/           # Lógica de negócio
├── routes/             # Endpoints da API REST
├── repositories/       # Acesso ao banco por entidade
├── middlewares/        # Auth, upload
├── controllers/        # Orquestração request → service
└── utils/              # logger, horario, validators
```

---

## Segurança em produção

1. **Nunca versionar** `.env` nem a pasta `auth_info/` — as credenciais da sessão WhatsApp estão lá
2. Gerar novos valores para `API_TOKEN`, `JWT_SECRET` e `DB_PASSWORD` antes do deploy
3. Configurar `CSP_CONNECT_SRC` com o domínio real do frontend (não usar `*`)
4. Habilitar `DB_SSL=true` se o banco for remoto
5. Usar HTTPS em produção (nginx, Caddy ou similar como proxy reverso)
