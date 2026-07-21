#!/usr/bin/env bash
#
# Backup do PostgreSQL do chatbot (pg_dump rodando dentro do container).
# Gera um dump comprimido, CRIPTOGRAFADO (AES-256, via openssl) e
# timestampado em ./backups, aplica retenção local e, se configurado,
# envia uma cópia para armazenamento fora do servidor (off-site).
#
# Uso:
#   bash scripts/backup.sh
#
# Agendamento:
#   - Linux/cron:      0 3 * * *  cd /caminho/do/projeto && bash scripts/backup.sh
#   - Windows:         Agendador de Tarefas chamando "bash scripts/backup.sh"
#
# Config por variável de ambiente (com defaults):
#   PG_CONTAINER            nome do container do Postgres (chatbot_rildon_postgres)
#   DB_USER / DB_NAME       usuário e banco (postgres / chatbot_rildon)
#   BACKUP_DIR              pasta de destino (./backups)
#   BACKUP_RETENTION_DAYS   dias a manter localmente (14)
#   BACKUP_ENCRYPTION_KEY   OBRIGATORIA. Senha usada para cifrar o dump
#                           (AES-256-CBC + PBKDF2, via openssl). Sem ela,
#                           o backup e abortado - nunca gravamos dump em
#                           texto puro no disco.
#                           Gere uma com:
#                             openssl rand -base64 48
#   BACKUP_REMOTE           OPCIONAL. Destino rclone (ex: "s3:meu-bucket/rildon")
#                           para enviar o dump cifrado para fora do servidor
#                           logo apos cria-lo. Requer rclone instalado e
#                           configurado (rclone config). Se ausente, o backup
#                           permanece so local (com aviso).
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-chatbot_rildon_postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-chatbot_rildon}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

if [ -z "$BACKUP_ENCRYPTION_KEY" ]; then
  echo "[backup] ERRO: BACKUP_ENCRYPTION_KEY nao definida." >&2
  echo "[backup] Dumps de banco contem dados pessoais (LGPD) - nao geramos" >&2
  echo "[backup] backup em texto puro. Defina a variavel e tente de novo. Gere uma com:" >&2
  echo "[backup]   openssl rand -base64 48" >&2
  exit 1
fi

# openssl "-pass env:VAR" le do ambiente do processo filho - precisa estar
# exportada, mesmo que ja viesse setada (ex: de um .env sem "export").
export BACKUP_ENCRYPTION_KEY

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
PLAIN_FILE="$BACKUP_DIR/${DB_NAME}_${TS}.sql.gz"
ENC_FILE="${PLAIN_FILE}.enc"

echo "[backup] Gerando dump ..."
# --clean --if-exists: o dump recria objetos do zero na restauracao
docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip > "$PLAIN_FILE"

# Falha se o dump saiu vazio (nao deixa "backup fantasma")
if [ ! -s "$PLAIN_FILE" ]; then
  echo "[backup] ERRO: dump vazio - removendo arquivo." >&2
  rm -f "$PLAIN_FILE"
  exit 1
fi

echo "[backup] Cifrando (AES-256-CBC + PBKDF2) ..."
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -pass env:BACKUP_ENCRYPTION_KEY \
  -in "$PLAIN_FILE" -out "$ENC_FILE"

# O dump em texto puro so existiu no disco por poucos segundos; removemos
# assim que a versao cifrada existe. shred sobrescreve antes de apagar
# quando disponivel (fallback silencioso para rm em filesystems que nao suportam).
if command -v shred >/dev/null 2>&1; then
  shred -u "$PLAIN_FILE"
else
  rm -f "$PLAIN_FILE"
fi

echo "[backup] OK - $(du -h "$ENC_FILE" | cut -f1) - $ENC_FILE"

# Retencao local: remove dumps cifrados mais antigos que RETENTION_DAYS
DELETED="$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz.enc" -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
echo "[backup] Retencao local: mantendo ${RETENTION_DAYS} dias (removidos agora: ${DELETED})"

# Off-site: envia a copia cifrada para um remoto rclone, se configurado.
# Isso e o que garante que um backup sobrevive a uma falha total do servidor
# (disco, incendio, ransomware que tambem acerta ./backups local).
if [ -n "$BACKUP_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[backup] Enviando copia off-site para $BACKUP_REMOTE ..."
    if rclone copy "$ENC_FILE" "$BACKUP_REMOTE"; then
      echo "[backup] Off-site OK."
    else
      echo "[backup] AVISO: falha ao enviar para $BACKUP_REMOTE - backup local ainda esta OK." >&2
    fi
  else
    echo "[backup] AVISO: BACKUP_REMOTE definido mas rclone nao esta instalado - pulando off-site." >&2
  fi
else
  echo "[backup] AVISO: BACKUP_REMOTE nao definido - este backup existe SO neste servidor." >&2
fi

