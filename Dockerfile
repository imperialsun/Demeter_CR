# Multi-stage Dockerfile: build with Node, serve with Nginx (static files)

FROM node:25.8.1-alpine AS builder
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
FROM nginx:1.29.6-alpine3.23
# Refresh zlib from Alpine repositories when the upstream nginx image lags behind security rebuilds.
RUN apk upgrade --no-cache zlib

# Copy built static assets
COPY --from=builder /app/dist /srv

# Runtime Nginx config with SPA fallback, security headers and tuned cache headers.
COPY docker/nginx/transcode.conf /etc/nginx/nginx.conf
COPY docker/nginx/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
USER nginx

ENTRYPOINT ["/entrypoint.sh"]
