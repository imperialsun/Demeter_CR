# Deployment and operations

## Overview

The repository ships with:

- a multi-stage production image (`Dockerfile`),
- production compose stack (`docker-compose.yml`),
- development compose stack (`docker-compose.dev.yml`),
- helper scripts (`install.sh`, `deploy.sh`).

## Production Dockerfile

Stages:

1. build stage on `node:25.6.1-alpine`.
2. `npm ci` then `npm run build:prod`.
3. runtime stage on `nginx:alpine` serving `dist/` on port `3000`.

Critical build args:

- `VITE_OBFUSCATE`.
- `LOGIN_PASSWORDS`.

## Production compose

Services:

- `transcode`: static app via Nginx + Traefik labels.

Network prerequisite:

```bash
docker network create proxy || true
```

Start:

```bash
docker compose up --build -d
```

Stop:

```bash
docker compose down
```

## Development compose

Main service: `transcode-dev` (Node container, source mount, `npm run dev -- --host 0.0.0.0 --port 3000`).

Start:

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Runtime Nginx and cache policy

`docker/nginx/transcode.conf` provides:

- SPA fallback (`/index.html`),
- security headers,
- path-based cache-control:
  - `/assets/`: immutable long cache,
  - `/onnx/` and `/ffmpeg/`: `must-revalidate`.

## Production runbook

### Startup

1. ensure `proxy` network exists,
2. ensure build args are set,
3. run `docker compose up --build -d`,
4. validate health:

```bash
docker compose ps
curl -I http://localhost:3000/index.html
curl -I http://localhost:3000/localupload
```

### Update

```bash
git pull
docker compose up --build -d
```

### Basic rollback

- switch to known-good commit,
- rebuild image and relaunch stack.

```bash
git checkout <known-good-commit>
docker compose up --build -d
```

### Header verification

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`

## `install.sh`

Purpose:

- interactive/non-interactive deployment helper,
- generates runtime override files,
- configures public URL, Gradio upstream, obfuscation, `LOGIN_PASSWORDS`.

It does not directly modify `docker-compose.yml`.

## `deploy.sh`

Purpose:

- uploads repository to remote host via `rsync` (fallback `tar+ssh`).

It does not automatically restart remote containers.

## Monitoring and incident response

- runtime logs: `docker compose logs -f transcode`.
- smoke validation: `prod-smoke.yml`.
- security scanning: `trivy.yml`.
- static analysis: `codeql.yml`.

## Related docs

- security model: [`security-privacy.md`](security-privacy.md)
- CI/quality: [`ci-quality-observability.md`](ci-quality-observability.md)
- troubleshooting: [`troubleshooting.md`](troubleshooting.md)
