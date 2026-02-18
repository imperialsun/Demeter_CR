# Multi-stage Dockerfile: build with Node, serve with Caddy (static files)

FROM node:25.6.1-alpine AS builder
WORKDIR /app
ARG VITE_OBFUSCATE=1
ARG LOGIN_PASSWORDS=
ENV VITE_OBFUSCATE=${VITE_OBFUSCATE}
ENV LOGIN_PASSWORDS=${LOGIN_PASSWORDS}

# Install deps and build
COPY package.json package-lock.json* ./
RUN npm ci --silent
COPY . .
RUN npm run build:prod

# Production image
FROM caddy:2-alpine

# Copy built static assets
COPY --from=builder /app/dist /srv

# Caddyfile will be copied by docker-compose build context; ensure it's present at /etc/caddy/Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

# Some VPS/container runtimes reject executing binaries with file capabilities
# (common symptom: "exec /usr/bin/caddy: operation not permitted").
# We do not need privileged ports here (app listens on 3000), so drop them.
# Install libcap only temporarily, then remove it to keep runtime surface smaller.
RUN apk add --no-cache --virtual .cap-tools libcap \
 && (setcap -r /usr/bin/caddy || true) \
 && apk del .cap-tools

# Some Caddy base variants may not expose a "caddy" passwd entry.
# Ensure a non-root runtime user exists consistently.
RUN if ! grep -q '^caddy:' /etc/passwd; then \
      addgroup -S caddy || true; \
      adduser -S -D -H -G caddy -s /sbin/nologin caddy; \
    fi

EXPOSE 3000
USER caddy

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
