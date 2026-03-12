#!/usr/bin/env bash
set -euo pipefail

APP_RUNTIME_MODE_DEFAULT="backend"
APP_BACKEND_BASE_URL_DEFAULT="/api/v1"
OBFUSCATE_DEFAULT="1"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.env.production.local"

APP_RUNTIME_MODE="${APP_RUNTIME_MODE:-$APP_RUNTIME_MODE_DEFAULT}"
APP_BACKEND_BASE_URL="${APP_BACKEND_BASE_URL:-$APP_BACKEND_BASE_URL_DEFAULT}"
LOGIN_PASSWORDS="${LOGIN_PASSWORDS:-}"
VITE_OBFUSCATE="${VITE_OBFUSCATE:-$OBFUSCATE_DEFAULT}"

NON_INTERACTIVE=0
DRY_RUN=0

log() { printf '[INFO] %s\n' "$*"; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

usage() {
  cat <<EOF
Usage: ./install.sh [options]

Options:
  --non-interactive             Do not prompt; use env/flags only.
  --dry-run                     Show actions but do not execute them.
  --runtime-mode <mode>         Runtime mode written to the front container (default: $APP_RUNTIME_MODE_DEFAULT).
  --backend-base-url <url>      Backend base URL exposed to the front (default: $APP_BACKEND_BASE_URL_DEFAULT).
  --login-passwords <value>     LOGIN_PASSWORDS build variable.
  --obfuscate <0|1>             VITE_OBFUSCATE build arg (default: $OBFUSCATE_DEFAULT).
  --help                        Show this help.

Environment variables:
  APP_RUNTIME_MODE
  APP_BACKEND_BASE_URL
  LOGIN_PASSWORDS
  VITE_OBFUSCATE
EOF
}

require_repo_root() {
  local required=(docker-compose.yml Dockerfile)
  local file
  for file in "${required[@]}"; do
    if [[ ! -f "$file" ]]; then
      err "Missing required file '$file'. Run this script from repository root."
      exit 1
    fi
  done
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

compose_detect() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  if have_cmd docker-compose; then
    echo "docker-compose"
    return 0
  fi
  return 1
}

prompt_with_default() {
  local prompt="$1"
  local default="$2"
  local answer
  read -r -p "$prompt [$default]: " answer
  if [[ -z "$answer" ]]; then
    printf '%s' "$default"
  else
    printf '%s' "$answer"
  fi
}

prompt_secret() {
  local prompt="$1"
  local value1 value2
  while true; do
    read -r -s -p "$prompt: " value1
    echo
    read -r -s -p "Confirm $prompt: " value2
    echo
    if [[ -z "$value1" ]]; then
      err "Value cannot be empty."
      continue
    fi
    if [[ "$value1" != "$value2" ]]; then
      err "Values do not match."
      continue
    fi
    printf '%s' "$value1"
    return
  done
}

collect_inputs() {
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ -z "$LOGIN_PASSWORDS" ]]; then
      err "LOGIN_PASSWORDS is required in non-interactive mode."
      exit 1
    fi
    return
  fi

  APP_RUNTIME_MODE="$(prompt_with_default "Runtime mode" "$APP_RUNTIME_MODE")"
  APP_BACKEND_BASE_URL="$(prompt_with_default "Backend base URL" "$APP_BACKEND_BASE_URL")"
  if [[ -z "$LOGIN_PASSWORDS" ]]; then
    LOGIN_PASSWORDS="$(prompt_secret "LOGIN_PASSWORDS")"
  fi
  VITE_OBFUSCATE="$(prompt_with_default "Enable obfuscation (0/1)" "$VITE_OBFUSCATE")"
}

write_env_file() {
  cat >"$ENV_FILE" <<EOF
APP_RUNTIME_MODE=$APP_RUNTIME_MODE
APP_BACKEND_BASE_URL=$APP_BACKEND_BASE_URL
LOGIN_PASSWORDS=$LOGIN_PASSWORDS
VITE_OBFUSCATE=$VITE_OBFUSCATE
EOF
}

run_compose() {
  local compose_bin="$1"
  local -a command
  if [[ "$compose_bin" == "docker compose" ]]; then
    command=(docker compose)
  else
    command=(docker-compose)
  fi
  command+=(--env-file "$ENV_FILE" up --build -d)

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: ${command[*]}"
    return
  fi

  "${command[@]}"
}

main() {
  local compose_bin

  require_repo_root
  if ! have_cmd docker; then
    err "docker command not found."
    exit 1
  fi
  compose_bin="$(compose_detect)" || {
    err "Neither 'docker compose' nor 'docker-compose' is available."
    exit 1
  }

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --runtime-mode)
        APP_RUNTIME_MODE="${2:-}"
        shift 2
        ;;
      --backend-base-url)
        APP_BACKEND_BASE_URL="${2:-}"
        shift 2
        ;;
      --login-passwords)
        LOGIN_PASSWORDS="${2:-}"
        shift 2
        ;;
      --obfuscate)
        VITE_OBFUSCATE="${2:-}"
        shift 2
        ;;
      --help)
        usage
        exit 0
        ;;
      *)
        err "Unknown argument: $1"
        usage
        exit 1
        ;;
    esac
  done

  collect_inputs
  write_env_file
  run_compose "$compose_bin"
  log "Frontend stack deployed."
}

main "$@"
