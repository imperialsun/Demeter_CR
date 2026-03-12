# Deploiement et operations

## Vue d ensemble

Le repo fournit:

- image multi-stage (`Dockerfile`),
- compose production (`docker-compose.yml`),
- compose dev (`docker-compose.dev.yml`),
- scripts auxiliaires (`install.sh`, `deploy.sh`).

## Dockerfile production

Etapes:

1. build sur `node:25.6.1-alpine`.
2. `npm ci` puis `npm run build:prod`.
3. runtime `nginx:alpine` servant `dist/` sur port `3000`.

Args build critiques:

- `VITE_OBFUSCATE`.
- `LOGIN_PASSWORDS`.

## Compose production

Services:

- `transcode`: app statique Nginx + labels Traefik.

Prerequis reseau:

```bash
docker network create proxy || true
```

Lancement:

```bash
docker compose up --build -d
```

Arret:

```bash
docker compose down
```

## Compose dev

Service principal: `transcode-dev` (Node, mount source, `npm run dev -- --host 0.0.0.0 --port 3000`).

Lancement:

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Nginx runtime et cache policy

`docker/nginx/transcode.conf` configure:

- SPA fallback (`/index.html`),
- headers securite,
- cache-control par famille d assets:
  - `/assets/`: immutable long cache,
  - `/onnx/` et `/ffmpeg/`: `must-revalidate`.

## Runbook production

### Demarrage

1. verifier `proxy` network,
2. verifier valeurs de build args,
3. `docker compose up --build -d`,
4. valider health:

```bash
docker compose ps
curl -I http://localhost:3000/index.html
curl -I http://localhost:3000/localupload
```

### Mise a jour

```bash
git pull
docker compose up --build -d
```

### Rollback basique

- revenir au commit precedent,
- relancer build image et stack.

```bash
git checkout <known-good-commit>
docker compose up --build -d
```

### Verification headers critiques

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: same-origin`

## Script `install.sh`

Role:

- assistant deployment interactif/non-interactif,
- genere fichiers override runtime,
- configure URL publique, upstream Gradio, obfuscation, `LOGIN_PASSWORDS`.

Ne modifie pas directement `docker-compose.yml`.

## Script `deploy.sh`

Role:

- upload du repo vers machine distante via `rsync` (fallback `tar+ssh`).

Ne redemarre pas automatiquement les conteneurs distants.

## Monitoring et incident response

- logs: `docker compose logs -f transcode`.
- pipeline smoke prod: `prod-smoke.yml`.
- scans securite: `trivy.yml`.
- analyse statique: `codeql.yml`.

## Liens

- securite: [`security-privacy.md`](security-privacy.md)
- CI/qualite: [`ci-quality-observability.md`](ci-quality-observability.md)
- depannage: [`troubleshooting.md`](troubleshooting.md)
