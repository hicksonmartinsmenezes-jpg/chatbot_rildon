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

# 4. Criar o primeiro usuário administrador (obrigatório — não existe
#    admin padrão; sem isso não há como logar no painel na primeira vez)
npm run create-admin -- admin "SenhaForte123" "Administrador"

# 5. Gerar o bundle do painel (obrigatório antes do primeiro uso e sempre
#    que editar arquivos em frontend/js ou frontend/css — o index.html
#    aponta para o bundle gerado, não para os arquivos individuais)
npm run build:frontend

# 6. Iniciar em desenvolvimento
npm run dev

# 7. Iniciar em produção
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

## Monitoramento de erros (Sentry) — opcional

Sem `SENTRY_DSN` definido no `.env`, o monitoramento fica completamente
desativado (no-op) — não é preciso configurar nada para rodar em
desenvolvimento. Para ativar em produção:

```bash
SENTRY_DSN=https://<sua-chave>@<seu-projeto>.ingest.sentry.io/<id>
SENTRY_TRACES_SAMPLE_RATE=0   # 0 = só erros, sem tracing de performance
# SENTRY_RELEASE=chatbot-rildon@1.0.0
```

Captura automaticamente `uncaughtException`, `unhandledRejection` e erros
5xx do Express (erros 4xx — validação, autenticação, etc. — não são
enviados, pois são esperados e não indicam bug).

**Importante ao adicionar/atualizar essa dependência via Docker:** o
`docker-compose.yml` usa um volume anônimo em `/app/node_modules` que
sobrevive a `docker compose up --build` — se o container reclamar de
`Cannot find module '@sentry/node'` (ou qualquer outra dependência nova)
mesmo após reconstruir a imagem, rode `docker compose up --build
--renew-anon-volumes` para forçar a recriação do volume.

---

## Backup e restauração do banco

O dump do Postgres é **sempre cifrado** (AES-256-CBC + PBKDF2, via `openssl`)
antes de tocar o disco — os dumps contêm dados pessoais de clientes (LGPD),
então nunca gravamos texto puro em `./backups`.

1. Gere uma chave de criptografia (uma vez, guarde em local seguro — sem ela
   os backups não podem ser restaurados):
   ```bash
   openssl rand -base64 48
   ```
2. Defina no `.env`: `BACKUP_ENCRYPTION_KEY=<a chave gerada acima>`

Backup manual (gera dump cifrado em `./backups` com retenção):
```bash
bash scripts/backup.sh
```

Restaurar um backup (⚠️ sobrescreve os dados atuais; aceita `.sql.gz.enc`
cifrado ou `.sql.gz` de backups antigos pré-criptografia):
```bash
bash scripts/restore.sh backups/chatbot_rildon_AAAAMMDD_HHMMSS.sql.gz.enc
```

Agendamento:
- **Linux/cron:** `0 3 * * * cd /caminho/projeto && bash scripts/backup.sh`
- **Windows:** Agendador de Tarefas chamando `bash scripts/backup.sh`

### Off-site (fora do servidor)

Um backup que só existe no mesmo servidor não protege contra falha de disco,
incêndio, ou ransomware que atinge `./backups` junto com o resto. Para enviar
a cópia cifrada para outro lugar (S3, Backblaze, outro servidor etc.):

1. Instale e configure o [rclone](https://rclone.org/) (`rclone config`) com o
   destino desejado.
2. Defina no `.env`: `BACKUP_REMOTE=nome-do-remoto:bucket/pasta`.
3. `scripts/backup.sh` envia automaticamente a cópia cifrada para lá logo após
   criá-la — se `rclone` não estiver instalado ou `BACKUP_REMOTE` não estiver
   definido, o script avisa no log e segue só com o backup local (não falha).

Os dumps ficam em `./backups` e são ignorados pelo Git.

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
│   ├── postgres.