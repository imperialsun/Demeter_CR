#!/usr/bin/env bash
set -euo pipefail

APP_DEFAULT_URL="transcode.demeter-sante.fr"
GRADIO_DEFAULT_URL="https://4e47b675ea4015a607.gradio.live"
OBFUSCATE_DEFAULT="1"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OVERRIDE_FILE="$SCRIPT_DIR/docker-compose.install.override.yml"
GRADIO_GENERATED_CONF="$SCRIPT_DIR/docker/gradio-proxy/nginx.generated.conf"
PROD_ENV_FILE="$SCRIPT_DIR/.env.production.local"

APP_PUBLIC_URL="${APP_PUBLIC_URL:-$APP_DEFAULT_URL}"
GRADIO_UPSTREAM_URL="${GRADIO_UPSTREAM_URL:-$GRADIO_DEFAULT_URL}"
LOGIN_PASSWORDS="${LOGIN_PASSWORDS:-}"
VITE_OBFUSCATE="${VITE_OBFUSCATE:-$OBFUSCATE_DEFAULT}"

NON_INTERACTIVE=0
SKIP_INSTALL=0
DRY_RUN=0

COMPOSE_BIN=""

log() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

usage() {
  cat <<EOF
Usage: ./install.sh [options]

Options:
  --non-interactive           Do not prompt; use env/flags only.
  --skip-install              Do not install system prerequisites automatically.
  --dry-run                   Show actions but do not execute docker/apply writes.
  --app-url <host-or-url>     Public app URL/host (default: $APP_DEFAULT_URL).
  --gradio-url <url>          Gradio upstream URL (default: $GRADIO_DEFAULT_URL).
  --login-passwords <value>   LOGIN_PASSWORDS build variable.
  --obfuscate <0|1>           VITE_OBFUSCATE build arg (default: $OBFUSCATE_DEFAULT).
  --help                      Show this help.

Environment variables:
  APP_PUBLIC_URL
  GRADIO_UPSTREAM_URL
  LOGIN_PASSWORDS
  VITE_OBFUSCATE

Direct launch without script remains supported:
  docker compose up --build -d
EOF
}

require_repo_root() {
  local required=(docker-compose.yml Dockerfile docker/gradio-proxy/nginx.conf)
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
    COMPOSE_BIN="docker compose"
    return 0
  fi
  if have_cmd docker-compose; then
    COMPOSE_BIN="docker-compose"
    return 0
  fi
  return 1
}

need_sudo() {
  [[ "${EUID:-$(id -u)}" -ne 0 ]]
}

run_with_optional_sudo() {
  if need_sudo; then
    sudo "$@"
  else
    "$@"
  fi
}

detect_os_family() {
  if [[ ! -f /etc/os-release ]]; then
    echo "unknown"
    return
  fi
  # shellcheck disable=SC1091
  source /etc/os-release
  local id_lc="${ID:-}"
  local like_lc="${ID_LIKE:-}"
  case "$id_lc" in
    ubuntu|debian) echo "debian" ;;
    arch|manjaro) echo "arch" ;;
    *)
      if [[ "$like_lc" == *debian* ]]; then
        echo "debian"
      elif [[ "$like_lc" == *arch* ]]; then
        echo "arch"
      else
        echo "unknown"
      fi
      ;;
  esac
}

install_prereqs_debian() {
  log "Installing prerequisites with apt (docker.io + docker-compose-plugin)..."
  run_with_optional_sudo apt-get update
  run_with_optional_sudo apt-get install -y docker.io docker-compose-plugin ca-certificates curl
  run_with_optional_sudo systemctl enable --now docker
}

install_prereqs_arch() {
  log "Installing prerequisites with pacman (docker + docker-compose)..."
  run_with_optional_sudo pacman -Sy --needed docker docker-compose
  run_with_optional_sudo systemctl enable --now docker
}

ensure_prereqs() {
  if [[ "$SKIP_INSTALL" == "1" ]]; then
    log "Skipping system installation checks (--skip-install)."
    return
  fi

  if have_cmd docker && compose_detect; then
    ok "Docker and Compose detected."
    return
  fi

  local os_family
  os_family="$(detect_os_family)"
  case "$os_family" in
    debian) install_prereqs_debian ;;
    arch) install_prereqs_arch ;;
    *)
      err "Unsupported OS for auto-install. Install Docker + Compose manually and rerun."
      exit 1
      ;;
  esac
}

require_compose() {
  if ! have_cmd docker; then
    err "docker command not found."
    exit 1
  fi
  if ! compose_detect; then
    err "Neither 'docker compose' nor 'docker-compose' is available."
    exit 1
  fi
  ok "Using compose command: $COMPOSE_BIN"
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
      warn "Value cannot be empty."
      continue
    fi
    if [[ "$value1" != "$value2" ]]; then
      warn "Values do not match. Please retry."
      continue
    fi
    printf '%s' "$value1"
    return
  done
}

normalize_host() {
  local raw="$1"
  local trimmed="${raw#"${raw%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [[ "$trimmed" =~ ^https?:// ]]; then
    trimmed="${trimmed#http://}"
    trimmed="${trimmed#https://}"
    trimmed="${trimmed%%/*}"
  fi
  echo "$trimmed"
}

validate_url() {
  local url="$1"
  [[ "$url" =~ ^https?://[^[:space:]]+$ ]]
}

prompt_inputs() {
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    if [[ -z "${LOGIN_PASSWORDS:-}" ]]; then
      err "LOGIN_PASSWORDS is required in non-interactive mode."
      exit 1
    fi
    APP_PUBLIC_URL="$(normalize_host "$APP_PUBLIC_URL")"
    if [[ -z "$APP_PUBLIC_URL" ]]; then
      err "APP_PUBLIC_URL is invalid."
      exit 1
    fi
    if ! validate_url "$GRADIO_UPSTREAM_URL"; then
      err "GRADIO_UPSTREAM_URL must be a valid http(s) URL."
      exit 1
    fi
    if [[ "$VITE_OBFUSCATE" != "0" && "$VITE_OBFUSCATE" != "1" ]]; then
      err "VITE_OBFUSCATE must be 0 or 1."
      exit 1
    fi
    return
  fi

  local app_input gradio_input obf_input confirm
  app_input="$(prompt_with_default "App URL (host or full URL)" "$APP_PUBLIC_URL")"
  APP_PUBLIC_URL="$(normalize_host "$app_input")"
  if [[ -z "$APP_PUBLIC_URL" ]]; then
    err "Invalid app URL/host."
    exit 1
  fi

  while true; do
    gradio_input="$(prompt_with_default "Gradio upstream URL" "$GRADIO_UPSTREAM_URL")"
    if validate_url "$gradio_input"; then
      GRADIO_UPSTREAM_URL="$gradio_input"
      break
    fi
    warn "Please enter a valid http(s) URL."
  done

  LOGIN_PASSWORDS="$(prompt_secret "LOGIN_PASSWORDS")"

  while true; do
    obf_input="$(prompt_with_default "Enable obfuscation? (1/0)" "$VITE_OBFUSCATE")"
    if [[ "$obf_input" == "0" || "$obf_input" == "1" ]]; then
      VITE_OBFUSCATE="$obf_input"
      break
    fi
    warn "Value must be 0 or 1."
  done

  cat <<EOF

Configuration summary:
  APP_PUBLIC_URL      = $APP_PUBLIC_URL
  GRADIO_UPSTREAM_URL = $GRADIO_UPSTREAM_URL
  VITE_OBFUSCATE      = $VITE_OBFUSCATE
  LOGIN_PASSWORDS     = [hidden]
EOF
  read -r -p "Continue with deployment? [y/N]: " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    err "Cancelled by user."
    exit 1
  fi
}

write_env_file() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: would write $PROD_ENV_FILE"
    return
  fi
  umask 077
  cat >"$PROD_ENV_FILE" <<EOF
LOGIN_PASSWORDS=$LOGIN_PASSWORDS
EOF
  chmod 600 "$PROD_ENV_FILE"
  ok "Wrote $PROD_ENV_FILE"
}

write_generated_nginx() {
  local host
  host="$(echo "$GRADIO_UPSTREAM_URL" | sed -E 's#^https?://([^/]+).*$#\1#')"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: would write $GRADIO_GENERATED_CONF"
    return
  fi
  cat >"$GRADIO_GENERATED_CONF" <<EOF
events {}

http {
  resolver 1.1.1.1 8.8.8.8 ipv6=off;

  server {
    listen 80;
    client_max_body_size 0;

    location / {
      proxy_pass $GRADIO_UPSTREAM_URL;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Host \$host;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
      proxy_set_header Connection "";
      proxy_ssl_server_name on;
      proxy_buffering off;
      proxy_request_buffering off;
      proxy_connect_timeout 30s;
      proxy_send_timeout 900s;
      proxy_read_timeout 900s;
      send_timeout 900s;
    }
  }
}
EOF
  ok "Wrote $GRADIO_GENERATED_CONF"
}

write_override_compose() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: would write $OVERRIDE_FILE"
    return
  fi
  {
    cat <<EOF
services:
  transcode:
    build:
      args:
        VITE_OBFUSCATE: "$VITE_OBFUSCATE"
        LOGIN_PASSWORDS: "\${LOGIN_PASSWORDS}"
EOF
    if [[ "$APP_PUBLIC_URL" != "$APP_DEFAULT_URL" ]]; then
      cat <<EOF
    labels:
      - "traefik.http.routers.transcode.rule=Host(\`$APP_PUBLIC_URL\`)"
EOF
    fi
    cat <<EOF
  gradio-proxy:
    volumes:
      - ./docker/gradio-proxy/nginx.generated.conf:/etc/nginx/nginx.conf:ro
EOF
    if [[ "$APP_PUBLIC_URL" != "$APP_DEFAULT_URL" ]]; then
      cat <<EOF
    labels:
      - "traefik.http.routers.transcode-gradio.rule=Host(\`$APP_PUBLIC_URL\`) && PathPrefix(\`/gradio_api\`)"
      - "traefik.http.routers.transcode-gradio-ui.rule=Host(\`$APP_PUBLIC_URL\`) && PathPrefix(\`/gradio\`)"
EOF
    fi
  } >"$OVERRIDE_FILE"
  ok "Wrote $OVERRIDE_FILE"
}

ensure_proxy_network() {
  if docker network inspect proxy >/dev/null 2>&1; then
    ok "Docker network 'proxy' already exists."
    return
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: would create docker network 'proxy'"
    return
  fi
  docker network create proxy >/dev/null
  ok "Created docker network 'proxy'."
}

compose_up() {
  local base_cmd
  if [[ "$COMPOSE_BIN" == "docker compose" ]]; then
    base_cmd=(docker compose)
  else
    base_cmd=(docker-compose)
  fi

  local cmd=("${base_cmd[@]}" --env-file "$PROD_ENV_FILE" -f docker-compose.yml -f docker-compose.install.override.yml up --build -d)
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: ${cmd[*]}"
    return
  fi
  "${cmd[@]}"
  ok "Stack launched."
}

compose_ps() {
  local base_cmd
  if [[ "$COMPOSE_BIN" == "docker compose" ]]; then
    base_cmd=(docker compose)
  else
    base_cmd=(docker-compose)
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY-RUN: ${base_cmd[*]} --env-file $PROD_ENV_FILE -f docker-compose.yml -f docker-compose.install.override.yml ps"
    return
  fi
  "${base_cmd[@]}" --env-file "$PROD_ENV_FILE" -f docker-compose.yml -f docker-compose.install.override.yml ps
}

print_final_summary() {
  cat <<EOF

Deployment completed.
  App host:         $APP_PUBLIC_URL
  Gradio upstream:  $GRADIO_UPSTREAM_URL
  Obfuscation:      $VITE_OBFUSCATE
  Override file:    docker-compose.install.override.yml

Direct default launch still works without this script:
  docker compose up --build -d
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --non-interactive)
        NON_INTERACTIVE=1
        shift
        ;;
      --skip-install)
        SKIP_INSTALL=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --app-url)
        APP_PUBLIC_URL="${2:-}"
        shift 2
        ;;
      --gradio-url)
        GRADIO_UPSTREAM_URL="${2:-}"
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
      --help|-h)
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
}

main() {
  parse_args "$@"
  require_repo_root
  ensure_prereqs
  require_compose
  prompt_inputs
  ensure_proxy_network
  write_env_file
  write_generated_nginx
  write_override_compose
  compose_up
  compose_ps
  print_final_summary
}

main "$@"
