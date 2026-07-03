#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: bash scripts/production-docker-pull-with-mihomo.sh <image> [image...]" >&2
  exit 1
fi

mihomo_service="${TOKENINSIDE_MIHOMO_SERVICE:-mihomo.service}"
start_wait_seconds="${TOKENINSIDE_MIHOMO_START_WAIT_SECONDS:-10}"
has_mihomo_service="false"
cleanup_started="false"

docker_cmd() {
  if [ -n "${TOKENINSIDE_DOCKER_CMD:-}" ]; then
    read -r -a command_parts <<< "$TOKENINSIDE_DOCKER_CMD"
    "${command_parts[@]}" "$@"
  else
    docker "$@"
  fi
}

systemctl_cmd() {
  if [ -n "${TOKENINSIDE_SYSTEMCTL_CMD:-}" ]; then
    read -r -a command_parts <<< "$TOKENINSIDE_SYSTEMCTL_CMD"
    "${command_parts[@]}" "$@"
  else
    systemctl "$@"
  fi
}

cleanup_mihomo() {
  if [ "$has_mihomo_service" != "true" ] || [ "$cleanup_started" = "true" ]; then
    return
  fi

  cleanup_started="true"
  echo "stopping_mihomo=$mihomo_service"
  systemctl_cmd stop "$mihomo_service" >/dev/null 2>&1 || true
  systemctl_cmd disable "$mihomo_service" >/dev/null 2>&1 || true

  active_state="$(systemctl_cmd is-active "$mihomo_service" 2>/dev/null || true)"
  enabled_state="$(systemctl_cmd is-enabled "$mihomo_service" 2>/dev/null || true)"
  echo "mihomo_active=${active_state:-unknown}"
  echo "mihomo_enabled=${enabled_state:-unknown}"
}

trap cleanup_mihomo EXIT

if command -v systemctl >/dev/null 2>&1 && systemctl_cmd cat "$mihomo_service" >/dev/null 2>&1; then
  has_mihomo_service="true"
  echo "starting_mihomo=$mihomo_service"
  systemctl_cmd start "$mihomo_service"
  sleep "$start_wait_seconds"
else
  echo "mihomo_service_not_found=$mihomo_service"
  echo "continuing_without_mihomo=true"
fi

for image in "$@"; do
  echo "pulling_image=$image"
  docker_cmd pull "$image"
done

echo "pull_complete=true"
