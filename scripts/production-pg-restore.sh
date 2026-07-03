#!/usr/bin/env bash
set -euo pipefail

if [ "${TOKENINSIDE_CONFIRM_RESTORE:-}" != "true" ]; then
  echo "Refusing restore. Set TOKENINSIDE_CONFIRM_RESTORE=true to confirm." >&2
  exit 1
fi

if [ "$#" -ne 1 ]; then
  echo "Usage: TOKENINSIDE_CONFIRM_RESTORE=true bash scripts/production-pg-restore.sh <backup.dump>" >&2
  exit 1
fi

dump_path="$1"
container="${TOKENINSIDE_PG_CONTAINER:-tokeninside-postgres}"
app_container="${TOKENINSIDE_APP_CONTAINER:-tokeninside}"
database="${POSTGRES_DB:-tokeninside}"
user="${POSTGRES_USER:-tokeninside}"
backup_dir="${TOKENINSIDE_BACKUP_DIR:-./backups/postgres/pre-restore}"
stop_app="${TOKENINSIDE_RESTORE_STOP_APP:-false}"
restart_app="false"

docker_cmd() {
  if [ -n "${TOKENINSIDE_DOCKER_CMD:-}" ]; then
    read -r -a command_parts <<< "$TOKENINSIDE_DOCKER_CMD"
    "${command_parts[@]}" "$@"
  else
    docker "$@"
  fi
}

if [ ! -f "$dump_path" ]; then
  echo "Backup file not found: $dump_path" >&2
  exit 1
fi

if ! docker_cmd inspect "$container" >/dev/null 2>&1; then
  echo "PostgreSQL container not found: $container" >&2
  exit 1
fi

if [ "${TOKENINSIDE_SKIP_PRE_RESTORE_BACKUP:-}" != "true" ]; then
  TOKENINSIDE_BACKUP_DIR="$backup_dir" bash "$(dirname "$0")/production-pg-backup.sh"
fi

if [ "$stop_app" = "true" ] && docker_cmd inspect "$app_container" >/dev/null 2>&1; then
  if [ "$(docker_cmd inspect "$app_container" --format '{{.State.Running}}')" = "true" ]; then
    docker_cmd stop "$app_container" >/dev/null
    restart_app="true"
  fi
fi

restore_app() {
  if [ "$restart_app" = "true" ]; then
    docker_cmd start "$app_container" >/dev/null
  fi
}
trap restore_app EXIT

docker_cmd exec -i \
  -e PGOPTIONS="-c statement_timeout=0 -c lock_timeout=0" \
  "$container" \
  pg_restore -U "$user" -d "$database" --clean --if-exists --no-owner < "$dump_path"

echo "restored=$dump_path"
