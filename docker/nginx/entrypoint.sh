#!/bin/sh
set -eu

APP_RUNTIME_MODE="${APP_RUNTIME_MODE:-standalone}"
APP_BACKEND_BASE_URL="${APP_BACKEND_BASE_URL:-/api/v1}"

case "$APP_RUNTIME_MODE" in
  standalone|backend) ;;
  *)
    echo "Invalid APP_RUNTIME_MODE" >&2
    exit 1
    ;;
esac

case "$APP_BACKEND_BASE_URL" in
  //*)
    echo "APP_BACKEND_BASE_URL must not be protocol-relative" >&2
    exit 1
    ;;
  /*|https://*|http://localhost|http://localhost/*|http://localhost:*|http://127.0.0.1|http://127.0.0.1/*|http://127.0.0.1:*) ;;
  *)
    echo "APP_BACKEND_BASE_URL must be relative, HTTPS, or an HTTP loopback URL" >&2
    exit 1
    ;;
esac

# Limit the generated JavaScript to URL characters that cannot break out of the string literal.
if ! printf '%s' "$APP_BACKEND_BASE_URL" | grep -Eq '^[A-Za-z0-9:/?&=._~%+@,-]+$'; then
  echo "APP_BACKEND_BASE_URL contains unsupported characters" >&2
  exit 1
fi

printf 'window.__APP_RUNTIME_CONFIG__ = {\n  mode: "%s",\n  backendBaseUrl: "%s"\n};\n' \
  "$APP_RUNTIME_MODE" "$APP_BACKEND_BASE_URL" > /tmp/runtime-config.js

exec nginx -g 'daemon off;'
