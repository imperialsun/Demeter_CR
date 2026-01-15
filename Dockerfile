# Multi-stage Dockerfile: build with Node, serve with Caddy (static files)

FROM node:18-alpine AS builder
WORKDIR /app

# Install deps and build
COPY package.json package-lock.json* ./
RUN npm ci --silent
COPY . .
RUN npm run build

# Production image
FROM caddy:2-alpine

# Copy built static assets
COPY --from=builder /app/dist /srv

# Caddyfile will be copied by docker-compose build context; ensure it's present at /etc/caddy/Caddyfile
COPY Caddyfile /etc/caddy/Caddyfile

EXPOSE 3000

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
