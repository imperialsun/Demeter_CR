#!/bin/sh
set -eu

APP_RUNTIME_MODE="${APP_RUNTIME_MODE:-standalone}"
APP_BACKEND_BASE_URL="${APP_BACKEND_BASE_URL:-/api/v1}"

cat > /tmp/runtime-config.js <<CONFIG
window.__APP_RUNTIME_CONFIG__ = {
  mode: "${APP_RUNTIME_MODE}",
  backendBaseUrl: "${APP_BACKEND_BASE_URL}"
};
CONFIG

exec nginx -g 'daemon off;'
