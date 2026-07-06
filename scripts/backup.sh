#!/usr/bin/env bash
#
# Backup do PostgreSQL do chatbot (pg_dump rodando dentro do container).
# Gera um dump comprimido e timestampado em ./backups e aplica retenção.
#
# Uso:
#   bash scripts/backup.sh
#
# Agendamento:
#   - Linux/cron:      0 3 * * *  cd /caminho/do/projeto && bash scripts/backup.sh
#   - Windows:         Agendador de Tarefas chamando "bash scripts/backup.sh"
#   - Produção Docker: use o serviço "backup" do docker-compose.prod.example.yml
#
# Config por variável de ambiente (com defaults):
#   PG_CONTAINER           nome do container do Postgres (chatbot_rildon_postgres)
#   DB_USER / DB_NAME      usuário e banco (postgres / chatbot_rildon)
#   BACKUP_DIR             pasta de destino (./backups)
#   BACKUP_RETENTION_DAYS  dias a manter (14)
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-chatbot_rildon_postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-chatbot_rildon}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
FILE="$BACKUP_DIR/${DB_NAME}_${TS}.sql.gz"

echo "[backup] Gerando $FILE ..."
# --clean --if-exists: o dump recria objetos do zero na restauração
docker exec "$PG_CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists \
  | gzip > "$FILE"

# Falha se o dump saiu vazio (não deixa "backup fantasma")
if [ ! -s "$FILE" ]; then
  echo "[backup] ERRO: dump vazio — removendo arquivo." >&2
  rm -f "$FILE"
  exit 1
fi

echo "[backup] OK — $(du -h "$FILE" | cut -f1)"

# Retenção: remove dumps mais antigos que RETENTION_DAYS
DELETED="$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')"
echo "[backup] Retenção: mantendo ${RETENTION_DAYS} dias (removidos agora: ${DELETED})"
