#!/usr/bin/env bash
#
# Restaura um backup .sql.gz para o PostgreSQL do container.
# ATENÇÃO: sobrescreve os dados atuais do banco.
#
# Uso:
#   bash scripts/restore.sh backups/chatbot_rildon_YYYYMMDD_HHMMSS.sql.gz
set -euo pipefail

FILE="${1:-}"
PG_CONTAINER="${PG_CONTAINER:-chatbot_rildon_postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-chatbot_rildon}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Uso: $0 <arquivo.sql.gz>" >&2
  exit 1
fi

echo "[restore] ATENÇÃO: isto vai sobrescrever os dados de '$DB_NAME'."
echo "[restore] Restaurando de $FILE ..."

# ON_ERROR_STOP=1: aborta se algum comando SQL falhar (não deixa restauração parcial silenciosa)
gunzip -c "$FILE" | docker exec -i "$PG_CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null

echo "[restore] OK — banco restaurado."
