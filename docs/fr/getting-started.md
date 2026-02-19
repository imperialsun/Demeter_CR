# Demarrage rapide

## Prerequis

- Node.js `25.6.1` (voir `.nvmrc`).
- npm.
- Docker Engine + Compose plugin pour execution conteneurisee.
- Navigateur moderne (Chrome/Edge recommande).

## Setup local (dev)

```bash
npm ci
npm run dev
```

Serveur Vite par defaut: `http://localhost:3000`.

## Build local

```bash
npm run build
npm run build:prod
npm run preview
```

`build:prod` applique l obfuscation selective (`scripts/obfuscate-dist.mjs`) si `VITE_OBFUSCATE != 0`.

## Scripts npm utiles

- `npm run dev`: serveur Vite.
- `npm run build`: audit observabilite + build TypeScript/Vite.
- `npm run build:prod`: build + obfuscation selective.
- `npm run lint`: ESLint.
- `npm run test`: Vitest.
- `npm run test:ci`: tests + couverture.
- `npm run coverage:project`: verifie seuil de couverture projet.
- `npm run docs:check`: validation documentation (liens, ancres, parite FR/EN).

## Setup Docker production

```bash
docker network create proxy || true
docker compose up --build -d
```

Verification minimale:

```bash
docker compose ps
curl -I http://localhost:3000/index.html
```

## Setup Docker dev

```bash
docker network create proxy || true
docker compose -f docker-compose.dev.yml up -d
```

## Parametres sensibles

- `LOGIN_PASSWORDS`: mots de passe login (hashes injectes au build via `vite.config.ts`).
- `VITE_OBFUSCATE`: `1` (actif) ou `0` (desactive).

## Erreurs frequentes de setup

### Node version mismatch

Symptome: `npm ci` echoue avec contrainte engine.

Action:

```bash
nvm use
```

### Backend local indisponible

Symptome: message "Aucun backend utilisable".

Actions:

- verifier presence des assets `public/onnx/*`,
- verifier headers COOP/COEP,
- verifier console navigateur et onglet network.

### WASM multithread inactif

Symptome: fallback single-thread malgre machine puissante.

Actions:

- verifier `window.crossOriginIsolated === true`,
- verifier headers:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

## Suite recommandee

- Architecture: [`architecture.md`](architecture.md)
- Transcription locale: [`local-transcription.md`](local-transcription.md)
- Deploiement complet: [`deployment-operations.md`](deployment-operations.md)
