# Demarrage rapide

## Prerequis

- Node.js `25.8.1` (voir `.nvmrc`).
- npm.
- Docker Engine + Compose plugin pour execution conteneurisee.
- Navigateur moderne (Chrome/Edge recommande).

## Setup local (dev)

```bash
npm ci
npm run dev
```

Serveur Vite par defaut: `http://localhost:3000`.
La configuration runtime de dev pointe vers `http://localhost:8080/api/v1`, donc la stack Backend doit tourner sur ce port pour le mode backend.

## Build local

```bash
npm run build
npm run build:prod
npm run preview
```

`build:prod` applique l obfuscation selective par defaut (`scripts/obfuscate-dist.mjs`).

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
docker compose up --build -d
```

Verification minimale:

```bash
docker compose ps
curl -I http://localhost:3000/index.html
```

## Setup Docker dev

```bash
docker compose -f compose.dev.yml up -d
```

## Parametres sensibles

- Le repo conserve seulement deux fichiers env suivis pour les hashes de login: `.env.development` et `.env.production`.
- `LOGIN_PASSWORDS`: mots de passe login (hashes injectes au build via `vite.config.ts`).

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
