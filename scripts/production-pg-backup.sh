#!/usr/bin/env bash
set -euo pipefail

container="${TOKENINSIDE_PG_CONTAINER:-tokeninside-postgres}"
database="${POSTGRES_DB:-tokeninside}"
user="${POSTGRES_USER:-tokeninside}"
backup_dir="${TOKENINSIDE_BACKUP_DIR:-./backups/postgres}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output="${backup_dir}/tokeninside-postgres-${timestamp}.dump"
tmp_output="${output}.tmp"

docker_cmd() {
  if [ -n "${TOKENINSIDE_DOCKER_CMD:-}" ]; then
    read -r -a command_parts <<< "$TOKENINSIDE_DOCKER_CMD"
    "${command_parts[@]}" "$@"
  else
    docker "$@"
  fi
}

mkdir -p "$backup_dir"

if ! docker_cmd inspect "$container" >/dev/null 2>&1; then
  echo "PostgreSQL container not found: $container" >&2
  exit 1
fi

if [ -e "$output" ] || [ -e "$tmp_output" ]; then
  echo "Backup output already exists: $output" >&2
  exit 1
fi

docker_cmd exec "$container" pg_dump -U "$user" -d "$database" -Fc > "$tmp_output"
mv "$tmp_output" "$output"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$output" > "${output}.sha256"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$output" > "${output}.sha256"
fi

bytes="$(wc -c < "$output" | tr -d ' ')"
echo "backup=$output"
echo "bytes=$bytes"
if [ -f "${output}.sha256" ]; then
  echo "sha256_file=${output}.sha256"
fi
