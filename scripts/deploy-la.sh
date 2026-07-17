#!/usr/bin/env bash
set -euo pipefail

require_value() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "${name} is required" >&2
    exit 2
  fi
}

require_value DEPLOY_DIR
require_value RELEASE_DIR
require_value RELEASE_ID
require_value TOKENINSIDE_IMAGE

reset_staging_data="${RESET_STAGING_DATA:-false}"
case "$reset_staging_data" in
  true | false) ;;
  *)
    echo "RESET_STAGING_DATA must be true or false" >&2
    exit 2
    ;;
esac

case "$RELEASE_ID" in
  *[!A-Za-z0-9._-]* | "")
    echo "RELEASE_ID contains unsupported characters" >&2
    exit 2
    ;;
esac

case "$TOKENINSIDE_IMAGE" in
  ghcr.io/voidintheshell/tokeninside:sha-*) ;;
  *)
    echo "TOKENINSIDE_IMAGE must be an immutable TokenInside GHCR sha tag" >&2
    exit 2
    ;;
esac

if [ ! -f "${DEPLOY_DIR}/.env" ]; then
  echo "Missing runtime environment file: ${DEPLOY_DIR}/.env" >&2
  exit 2
fi

upsert_runtime_value() {
  local name="$1"
  local value="$2"
  local env_file="${DEPLOY_DIR}/.env"
  if grep -q "^${name}=" "$env_file"; then
    sed -i "s/^${name}=.*/${name}=${value}/" "$env_file"
  else
    printf '%s=%s\n' "$name" "$value" >> "$env_file"
  fi
}

echo "Reconciling LA staging connection and worker budgets"
upsert_runtime_value DATABASE_POOL_MAX 8
upsert_runtime_value DATABASE_SETTLEMENT_POOL_MAX 2
upsert_runtime_value DATABASE_CONTROL_POOL_MAX 4
upsert_runtime_value DATABASE_QUOTA_SUBMIT_POOL_MAX 2
upsert_runtime_value DATABASE_QUOTA_SUBMIT_CONNECTION_TIMEOUT_MS 1000
upsert_runtime_value DATABASE_QUOTA_SUBMIT_STATEMENT_TIMEOUT_MS 3000
upsert_runtime_value DATABASE_QUOTA_SUBMIT_LOCK_TIMEOUT_MS 1000
upsert_runtime_value DATABASE_LOCK_POOL_MAX 10
upsert_runtime_value TOKENINSIDE_QUOTA_OPERATION_CONCURRENCY_MAX 1
upsert_runtime_value TOKENINSIDE_USAGE_SETTLEMENT_CONCURRENCY_MAX 16
upsert_runtime_value TOKENINSIDE_BILLING_MATERIALIZATION_CONCURRENCY_MAX 4
upsert_runtime_value TOKENINSIDE_USAGE_SYNC_CONTINUATION_DELAY_MS 250

compose_file="${RELEASE_DIR}/docker-compose.yml"
if [ ! -f "$compose_file" ]; then
  echo "Missing release compose file: ${compose_file}" >&2
  exit 2
fi

compose() {
  docker compose \
    --project-directory "$DEPLOY_DIR" \
    --env-file "${DEPLOY_DIR}/.env" \
    -f "$compose_file" \
    "$@"
}

deploy_state_dir="${DEPLOY_DIR}/.deploy"
backup_dir="${deploy_state_dir}/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="${backup_dir}/postgres-${timestamp}-${RELEASE_ID}.dump"
backup_tmp_path="${backup_path}.tmp"
previous="$(cat "${deploy_state_dir}/current-image" 2>/dev/null || true)"
app_update_started=false

mkdir -p "$deploy_state_dir" "$backup_dir"
umask 077

record_failure() {
  local status="$1"
  printf '%s status=%s release=%s image=%s previous=%s\n' \
    "$(date -u -Is)" "$status" "$RELEASE_ID" "$TOKENINSIDE_IMAGE" "$previous" \
    >> "${deploy_state_dir}/releases.log"
}

rollback_application() {
  local exit_code="$1"
  set +e
  if [ "$reset_staging_data" = true ]; then
    echo "Clean rebuild failed; discarded staging data cannot be restored automatically" >&2
    record_failure "clean_rebuild_failed"
  elif [ "$app_update_started" = true ] && [ -n "$previous" ]; then
    echo "Deployment failed after application replacement; restoring ${previous}" >&2
    export TOKENINSIDE_IMAGE="$previous"
    compose pull tokeninside
    compose up -d --no-deps --wait --force-recreate tokeninside
    curl --fail --silent --show-error http://127.0.0.1:16878/api/health >/dev/null
    printf '%s\n' "$previous" > "${deploy_state_dir}/current-image"
    record_failure "rolled_back"
  else
    echo "Deployment failed before application replacement; database was not restored automatically" >&2
    record_failure "failed_before_app_update"
  fi
  exit "$exit_code"
}

trap 'exit_code=$?; echo "Deployment command failed at line ${LINENO}: ${BASH_COMMAND}" >&2; rollback_application "$exit_code"' ERR

compose config --quiet
if [ "$reset_staging_data" = true ]; then
  echo "Discarding LA staging application data, PostgreSQL data, and stored recovery dumps"
  compose down --remove-orphans --volumes
  find "$backup_dir" -mindepth 1 -maxdepth 1 -type f -delete
  compose up -d --wait postgres
elif ! compose ps --status running --services postgres | grep -qx postgres; then
  echo "PostgreSQL is not running; starting the existing service before creating a recovery point"
  compose up -d --wait postgres
fi
compose ps --status running --services postgres | grep -qx postgres
POSTGRES_DB="$(compose exec -T postgres printenv POSTGRES_DB | tr -d '\r\n')"
POSTGRES_USER="$(compose exec -T postgres printenv POSTGRES_USER | tr -d '\r\n')"
require_value POSTGRES_DB
require_value POSTGRES_USER

if [ "$reset_staging_data" = true ]; then
  backup_path="discarded"
else
  printf 'Creating PostgreSQL recovery point: %s\n' "$backup_path"
  compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$backup_tmp_path"
  test -s "$backup_tmp_path"
  mv "$backup_tmp_path" "$backup_path"
  sha256sum "$backup_path" > "${backup_path}.sha256"
fi

printf '%s\n' "$previous" > "${deploy_state_dir}/previous-image"
export TOKENINSIDE_IMAGE

echo "Pulling immutable image ${TOKENINSIDE_IMAGE}"
compose pull tokeninside

echo "Running versioned database migrations"
compose run --rm --no-deps --entrypoint node tokeninside scripts/db-migrate.mjs

echo "Checking migrated database and runtime configuration"
compose run --rm --no-deps --entrypoint node tokeninside scripts/production-preflight.mjs

app_update_started=true
echo "Replacing TokenInside application container"
compose up -d --no-deps --wait --force-recreate tokeninside
curl --fail --silent --show-error http://127.0.0.1:16878/api/health >/dev/null

if [ -n "${APP_URL:-}" ]; then
  curl --fail --silent --show-error "${APP_URL%/}/api/health" >/dev/null
fi

image_revision="$(docker image inspect "$TOKENINSIDE_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
printf '%s\n' "$TOKENINSIDE_IMAGE" > "${deploy_state_dir}/current-image"
printf '%s\n' "$TOKENINSIDE_IMAGE" > "${deploy_state_dir}/last-successful-image"
printf '%s release=%s image=%s revision=%s backup=%s previous=%s status=success\n' \
  "$(date -u -Is)" "$RELEASE_ID" "$TOKENINSIDE_IMAGE" "$image_revision" "$backup_path" "$previous" \
  >> "${deploy_state_dir}/releases.log"

trap - ERR
echo "Deployment completed: ${TOKENINSIDE_IMAGE}"
