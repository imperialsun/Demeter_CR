# Getting started

## Prerequisites

- Node.js `25.8.1` (see `.nvmrc`).
- npm.
- Docker Engine + Compose plugin for containerized execution.
- Modern browser (Chrome/Edge recommended).

## Local setup (dev)

```bash
npm ci
npm run dev
```

Default Vite URL: `http://localhost:3000`.
The dev runtime config points to `http://localhost:8080/api/v1`, so the Backend stack must be running on that port for backend mode.

## Local build

```bash
npm run build
npm run build:prod
npm run preview
```

`build:prod` applies selective obfuscation by default (`scripts/obfuscate-dist.mjs`).

## Useful npm scripts

- `npm run dev`: Vite dev server.
- `npm run build`: observability audit + TypeScript/Vite build.
- `npm run build:prod`: build + selective obfuscation.
- `npm run lint`: ESLint.
- `npm run test`: Vitest.
- `npm run test:ci`: tests + coverage.
- `npm run coverage:project`: checks project coverage threshold.
- `npm run docs:check`: documentation validation (links, anchors, FR/EN parity).

## Docker production stack

```bash
docker compose up --build -d
```

Minimal checks:

```bash
docker compose ps
curl -I http://localhost:3000/index.html
```

## Docker dev stack

```bash
docker compose -f compose.dev.yml up -d
```

## Sensitive configuration

- The repo keeps two tracked env files for login hashes: `.env.development` and `.env.production`.
- `LOGIN_PASSWORDS`: login passwords (hashed at build time in `vite.config.ts`).

## Frequent setup errors

### Node version mismatch

Symptom: `npm ci` fails on engine constraints.

Fix:

```bash
nvm use
```

### No usable local backend

Symptom: startup error saying no usable backend.

Checks:

- verify `public/onnx/*` assets are served,
- verify COOP/COEP headers,
- inspect browser console/network.

### WASM multithread unavailable

Symptom: single-thread fallback on capable hardware.

Checks:

- `window.crossOriginIsolated === true`,
- required headers:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`

## Suggested next steps

- Architecture: [`architecture.md`](architecture.md)
- Local pipeline: [`local-transcription.md`](local-transcription.md)
- Deployment runbooks: [`deployment-operations.md`](deployment-operations.md)
