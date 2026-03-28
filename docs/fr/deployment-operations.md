# Deploiement et operations

## Vue d ensemble

Le repo fournit:

- image multi-stage (`Dockerfile`),
- compose production (`compose.yml`),
- compose dev (`compose.dev.yml`),
- orchestrateur du workspace (`../deploy-transcode.sh`).

## Dockerfile production

Etapes:

1. build sur `node:25.8.1-alpine3.23`.
2. `npm ci` puis `npm run build:prod`.
3. runtime `nginx:1.29.6-alpine3.23` servant `dist/` sur port `3000`.

Variable de build critique:

- `LOGIN_PASSWORDS`.

`scripts/obfuscate-dist.mjs` active l obfuscation selective par defaut.

## Compose production

Services:

- `front`: app statique Nginx sur le port `3000`.
- la configuration runtime est fixee explicitement dans le compose sur l URL backend de production.

Environnement:

- `APP_RUNTIME_MODE=backend`
- `APP_BACKEND_BASE_URL=https://trapi.demeter-sante.fr/api/v1`

Lancement:

```bash
docker compose up --build -d
```

Arret:

```bash
docker compose down
```

## Compose dev

Service principal: `front` (Node, mount source, `npm ci --silent && npm run dev`).

Le fallback [`public/runtime-config.js`](../public/runtime-config.js) pointe deja vers `http://localhost:8080/api/v1`, donc aucune couche proxy n est necessaire.

Lancement:

```bash
docker compose -f compose.dev.yml up -d
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

1. `docker compose up --build -d`,
2. valider health:

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

## Deploiement workspace

Depuis la racine du workspace:

```bash
./deploy-transcode.sh local
./deploy-transcode.sh ariane
```

- `local` demarre les stacks dev du Backend, de Front user et d Admin panel dans l ordre.
- `ariane` synchronise le workspace vers l hote distant et demarre la stack de production.
- `--dry-run` affiche les actions sans rien modifier.

## Monitoring et incident response

- logs: `docker compose logs -f front`.
- pipeline smoke prod: `prod-smoke.yml`.
- scans securite: `trivy.yml`.
- analyse statique: `codeql.yml`.

## Liens

- securite: [`security-privacy.md`](security-privacy.md)
- CI/qualite: [`ci-quality-observability.md`](ci-quality-observability.md)
- depannage: [`troubleshooting.md`](troubleshooting.md)
