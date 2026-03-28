# Deployment and operations

## Overview

The repository ships with:

- a multi-stage production image (`Dockerfile`),
- production compose stack (`compose.yml`),
- development compose stack (`compose.dev.yml`),
- the workspace orchestrator (`../deploy-transcode.sh`).

## Production Dockerfile

Stages:

1. build stage on `node:25.8.1-alpine3.23`.
2. `npm ci` then `npm run build:prod`.
3. runtime stage on `nginx:1.29.6-alpine3.23` serving `dist/` on port `3000`.

Critical build input:

- `LOGIN_PASSWORDS`.

`scripts/obfuscate-dist.mjs` enables selective obfuscation by default.

## Production compose

Services:

- `front`: static app via Nginx on port `3000`.
- runtime config is set explicitly in the compose file for the production backend URL.

Environment:

- `APP_RUNTIME_MODE=backend`
- `APP_BACKEND_BASE_URL=https://trapi.demeter-sante.fr/api/v1`

Start:

```bash
docker compose up --build -d
```

Stop:

```bash
docker compose down
```

## Development compose

Main service: `front` (Node container, source mount, `npm ci --silent && npm run dev`).

The repository fallback [`public/runtime-config.js`](../public/runtime-config.js) already points to `http://localhost:8080/api/v1`, so no proxy layer is needed.

Start:

```bash
docker compose -f compose.dev.yml up -d
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

1. run `docker compose up --build -d`,
2. validate health:

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

## Workspace deployment

From the workspace root:

```bash
./deploy-transcode.sh local
./deploy-transcode.sh ariane
```

- `local` starts Backend, Front user, and Admin panel dev stacks in order.
- `ariane` syncs the workspace to the remote host and starts the remote production stack.
- `--dry-run` previews the actions without mutating anything.

## Monitoring and incident response

- runtime logs: `docker compose logs -f front`.
- smoke validation: `prod-smoke.yml`.
- security scanning: `trivy.yml`.
- static analysis: `codeql.yml`.

## Related docs

- security model: [`security-privacy.md`](security-privacy.md)
- CI/quality: [`ci-quality-observability.md`](ci-quality-observability.md)
- troubleshooting: [`troubleshooting.md`](troubleshooting.md)
