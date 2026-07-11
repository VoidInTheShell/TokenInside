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
  if [ "$app_update_started" = true ] && [ -n "$previous" ]; then
    echo "Deployment failed after application replacement; restoring ${previous}" >&2
    export TOKENINSIDE_IMAGE="$previous"
    compose pull tokeninside
    compose up -d --no-deps --wait tokeninside
    curl --fail --silent --show-error http://127.0.0.1:16878/api/health >/dev/null
    printf '%s\n' "$previous" > "${deploy_state_dir}/current-image"
    record_failure "rolled_back"
  else
    echo "Deployment failed before application replacement; database was not restored automatically" >&2
    record_failure "failed_before_app_update"
  fi
  exit "$exit_code"
}

trap 'rollback_application $?' ERR

compose config --quiet
compose ps --status running postgres | grep -qx postgres
POSTGRES_DB="$(compose exec -T postgres printenv POSTGRES_DB | tr -d '\r\n')"
POSTGRES_USER="$(compose exec -T postgres printenv POSTGRES_USER | tr -d '\r\n')"
require_value POSTGRES_DB
require_value POSTGRES_USER

printf 'Creating PostgreSQL recovery point: %s\n' "$backup_path"
compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$backup_tmp_path"
test -s "$backup_tmp_path"
mv "$backup_tmp_path" "$backup_path"
sha256sum "$backup_path" > "${backup_path}.sha256"

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
compose up -d --no-deps --wait tokeninside
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
