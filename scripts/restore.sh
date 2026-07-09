#!/usr/bin/env bash
#
# Restaura um backup para o PostgreSQL do container. Aceita tanto o novo
# formato cifrado (.sql.gz.enc, gerado por scripts/backup.sh) quanto dumps
# antigos em texto puro (.sql.gz), para compatibilidade com backups feitos
# antes da criptografia ter sido adicionada.
# ATENÇÃO: sobrescreve os dados atuais do banco.
#
# Uso:
#   bash scripts/restore.sh backups/chatbot_rildon_YYYYMMDD_HHMMSS.sql.gz.enc
#
# Se o arquivo for .sql.gz.enc, é necessário BACKUP_ENCRYPTION_KEY (a mesma
# senha usada no backup) para decifrar.
set -euo pipefail

FILE="${1:-}"
PG_CONTAINER="${PG_CONTAINER:-chatbot_rildon_postgres}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-chatbot_rildon}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"

if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Uso: $0 <arquivo.sql.gz.enc | arquivo.sql.gz>" >&2
  exit 1
fi

echo "[restore] ATENÇÃO: isto vai sobrescrever os dados de '$DB_NAME'."

TMP_PLAIN=""
cleanup() {
  if [ -n "$TMP_PLAIN" ] && [ -f "$TMP_PLAIN" ]; then
    if command -v shred >/dev/null 2>&1; then
      shred -u "$TMP_PLAIN"
    else
      rm -f "$TMP_PLAIN"
    fi
  fi
}
trap cleanup EXIT

case "$FILE" in
  *.sql.gz.enc)
    if [ -z "$BACKUP_ENCRYPTION_KEY" ]; then
      echo "[restore] ERRO: arquivo cifrado, mas BACKUP_ENCRYPTION_KEY não definida." >&2
      exit 1
    fi
    export BACKUP_ENCRYPTION_KEY
    TMP_PLAIN="$(mktemp)"
    echo "[restore] Decifrando $FILE ..."
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
      -pass env:BACKUP_ENCRYPTION_KEY \
      -in "$FILE" -out "$TMP_PLAIN"
    DUMP_SOURCE="$TMP_PLAIN"
    ;;
  *.sql.gz)
    echo "[restore] Aviso: restaurando dump antigo em texto puro (sem criptografia)."
    DUMP_SOURCE="$FILE"
    ;;
  *)
    echo "[restore] ERRO: extensão não reconhecida (esperado .sql.gz.enc ou .sql.gz)." >&2
    exit 1
    ;;
esac

echo "[restore] Restaurando ..."
# ON_ERROR_STOP=1: aborta se algum comando SQL falhar (não deixa restauração parcial silenciosa)
gunzip -c "$DUMP_SOURCE" | docker exec -i "$PG_CONTAINER" \
  psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 >/dev/null

echo "[restore] OK — banco restaurado."
