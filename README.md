# Demeter Speech

[![CI](https://github.com/imperialsun/Demeter_CR/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/imperialsun/Demeter_CR/actions/workflows/ci.yml)
[![Prod Smoke](https://github.com/imperialsun/Demeter_CR/actions/workflows/prod-smoke.yml/badge.svg?branch=main)](https://github.com/imperialsun/Demeter_CR/actions/workflows/prod-smoke.yml)
[![CodeQL](https://github.com/imperialsun/Demeter_CR/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/imperialsun/Demeter_CR/actions/workflows/codeql.yml)
[![Trivy](https://github.com/imperialsun/Demeter_CR/actions/workflows/trivy.yml/badge.svg?branch=main)](https://github.com/imperialsun/Demeter_CR/actions/workflows/trivy.yml)
[![Coverage](https://codecov.io/gh/imperialsun/Demeter_CR/branch/main/graph/badge.svg)](https://codecov.io/gh/imperialsun/Demeter_CR)
[![Last commit](https://img.shields.io/github/last-commit/imperialsun/Demeter_CR)](https://github.com/imperialsun/Demeter_CR/commits/main)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

Application web qui transcrit des fichiers audio en local (100% sur le poste) ou via des APIs cloud, puis permet de générer des comptes rendus de réunion structurés (CRI/CRO/CRS).  
Elle propose aussi l’export des résultats (texte, sous-titres, JSON) et des réglages avancés pour la qualité, la performance et la confidentialité.

Browser-based app that transcribes audio locally or through cloud APIs, then generates structured meeting reports (CRI/CRO/CRS).  
It also includes export features (text, subtitles, JSON) and advanced settings for quality, performance, and privacy.

## J'ai la flemme (install en 1 ligne)

```bash
chmod +x install.sh && ./install.sh
```

## Je fais l'install comme un grand (prod manuelle)

### 1) Prérequis

- Docker installé (Engine + Compose plugin).
- Un reverse proxy Traefik opérationnel si tu utilises les labels `Host(...)`.
- Le réseau Docker externe `proxy` doit exister (une seule fois) :

```bash
docker network create proxy
```

### 2) Ce qu'il faut modifier avant le déploiement

- **Domaine app** :
- Si tu gardes `transcode.demeter-sante.fr`, ne change rien.
- Si tu utilises un autre domaine, remplace `transcode.demeter-sante.fr` dans `docker-compose.yml` sur les 3 labels:
- `traefik.http.routers.transcode.rule`
- `traefik.http.routers.transcode-gradio.rule`
- `traefik.http.routers.transcode-gradio-ui.rule`

- **URL Gradio distante** :
- Modifie `docker/gradio-proxy/nginx.conf` :
- `proxy_pass https://...`
- `proxy_set_header Host ...`

- **Mot de passe de connexion (important)** :
- Sans config explicite, le build peut retomber sur une valeur de démo.
- Ajoute `LOGIN_PASSWORDS` dans les args build de `docker-compose.yml` :

```yaml
services:
  transcode:
    build:
      args:
        VITE_OBFUSCATE: "1"
        LOGIN_PASSWORDS: "ChangeMoiMaintenant!"
```

- **Obfuscation** :
- `VITE_OBFUSCATE: "1"` = activée (recommandé prod).
- `VITE_OBFUSCATE: "0"` = désactivée.

### 3) Déployer

```bash
docker compose up --build -d
```

### 4) Vérifier

```bash
docker compose ps
docker compose logs -f transcode
curl -I http://localhost:3000
```

### 5) Mettre à jour / arrêter

```bash
docker compose up --build -d
docker compose down
```

---

## Français

### 1) Objectif

Demeter Speech permet de transcrire des fichiers audio avec deux approches :

- **Mode local** : transcription dans le navigateur via `@huggingface/transformers@next` (preview v4) + `onnxruntime-web` (WebGPU ou WASM).
- **Mode cloud** : prétraitement local puis transcription via un provider distant (Gradio, Whisper API Hugging Face, Mistral Voxtral).

L'application est conçue pour des comptes rendus de réunion.

L’interface propose aussi :

- réglages avancés (modèles, chunking, prétraitement, backend, cloud),
- visualisation des segments,
- métriques de télémétrie,
- export des résultats (`VTT`, `SRT`, `JSON`, `telemetry.json`).

### 2) Fonctionnalités clés

- Authentification par mot de passe (hash bcrypt injecté au build).
- Détection automatique du backend runtime (WebGPU / WASM).
- Fallback WebGPU -> WASM si nécessaire.
- Prétraitement audio local configurable :
- réduction de bruit,
- filtres passe-haut/passe-bas,
- normalisation LUFS,
- limiteur,
- VAD (détection voix/silence),
- auto-tuning des paramètres.
- Stratégies de chunking :
- séquentiel,
- overlap + dédoublonnage,
- détection de silences.
- Mode mémoire :
- `full` : décodage complet en mémoire,
- `progressive` : segmentation progressive (FFmpeg WASM + IndexedDB) pour gros fichiers.
- Affichage optionnel des timestamps mot à mot et de l’indice de confiance par segment.
- Page de télémétrie (timings, mémoire, timeline d’événements, alertes).
- Outils de debug (export logs, test de compatibilité des modèles).

### 3) Parcours utilisateur et flux applicatif

#### A. Démarrage application

Au boot (`src/main.tsx`) :

- installation du guard console + provider de debug,
- `initializeBackendSupport()` :
- test support WebGPU,
- vérification de présence des assets WASM ONNX sous `/onnx/`,
- test de capacité WASM multithread,
- hydratation des settings depuis le stockage local (`zustand` + `localStorage`),
- si aucun backend disponible, passage en état d’erreur + toast utilisateur.

#### B. Authentification

- Route publique : `/login`.
- Les routes applicatives sont protégées (`RequireAuth` dans `src/App.tsx`).
- Si auth OK : redirection vers `/localupload`.
- État auth stocké dans `localStorage` (`demeter-authenticated`).

Important :

- C’est un **verrouillage côté client**, pas une sécurité serveur forte.
- Le hash bcrypt est généré au build depuis `LOGIN_PASSWORDS` (ou `LOGIN_PASSWORD`) dans `vite.config.ts`.

#### C. Transcription locale (`/localupload`)

Pipeline général (`useTranscriptionController`) :

1. Import du fichier et lecture métadonnées.
2. Chargement pipeline ASR (`createAsrPipeline`) selon preset + backend.
3. Prétraitement audio (mode `quick` ou `full`).
4. Découpage en chunks.
5. Transcription chunk par chunk.
6. Normalisation / dédoublonnage du texte inter-chunks.
7. Calcul confiance segment + confiance globale.
8. Mise à jour progression + télémétrie.
9. Export des résultats.

Mode progressif :

- Segmente le média avec FFmpeg WASM (`src/lib/segmenter.ts`),
- met en cache des segments compressés dans IndexedDB (`src/lib/segment-cache.ts`),
- relit/traite segment par segment pour limiter l’empreinte mémoire.

#### D. Transcription cloud (`/cloudupload`)

Pipeline général (`useCloudTranscription`) :

1. Upload local du fichier.
2. Prétraitement local.
3. Encodage WAV.
4. Envoi vers provider cloud.
5. Récupération / parsing des segments.
6. Affichage + export.

Providers disponibles :

- `gradio` :
- URL par défaut `https://transcode.demeter-sante.fr/gradio`,
- flow orienté endpoint Gradio (upload + submit + récupération sortie SRT/texte).
- `whisper` :
- nécessite token Hugging Face,
- utilise `openai/whisper-large-v3-turbo` via HF Inference.
- `mistral` :
- nécessite clé API Mistral,
- endpoint par défaut `https://api.mistral.ai/v1/audio/transcriptions`,
- modèle par défaut `voxtral-mini-latest`,
- diarization activée par défaut.

Note :

- Le contexte personnalisé est utilisé côté Gradio.
- Dans les providers Whisper/Mistral du repo actuel, le contexte est volontairement ignoré.

### 4) Stockage local et persistance

- `zustand` : état applicatif runtime.
- `localStorage` :
- paramètres (`demeter-asr-settings`),
- état d’auth,
- cache de logs.
- `IndexedDB` :
- segments audio intermédiaires (mode progressif),
- caches liés aux modèles selon runtime navigateur.
- Cache navigateur :
- modèles Transformers.js (`env.useBrowserCache = true`),
- assets statiques.

### 5) Exports

Exports disponibles depuis l’UI :

- `VTT`,
- `SRT`,
- `JSON` (segments),
- `telemetry.json`.

Chaque export inclut un en-tête avec :

- contexte d’export,
- paramètres actifs,
- informations runtime (backend, modèle, etc.).

### 6) Sécurité

- Workflows actifs : `Prod Smoke`, `CodeQL`, `Trivy`.
- Politique vulnérabilités : Trivy bloque le pipeline sur `HIGH` et `CRITICAL`.
- Liens sécurité :
1. https://github.com/imperialsun/Demeter_CR/security
2. https://github.com/imperialsun/Demeter_CR/security/code-scanning
3. https://github.com/imperialsun/Demeter_CR/security/dependabot
4. https://github.com/imperialsun/Demeter_CR/network/dependencies
- Note : un badge peut afficher `no status` tant que le workflow n’a pas encore tourné au moins une fois.

### 7) Stack technique

- Frontend : React 19, TypeScript, Vite, React Router.
- State management : Zustand.
- UI : TailwindCSS + Radix UI.
- ASR local : `@huggingface/transformers@next` (preview v4), `onnxruntime-web`.
- Audio : Web Audio API + FFmpeg WASM.
- Tests : Vitest + Testing Library.

### 8) Prérequis

- Node.js 18+ (Node 20 recommandé en local).
- npm.
- Navigateur moderne (Chrome/Edge recommandé pour WebGPU/WASM).
- Headers d’isolation cross-origin pour le multithread WASM :
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

### 9) Installation et lancement (local)

```bash
npm ci
```

Créer un fichier `.env` :

```bash
LOGIN_PASSWORDS=monmotdepasse
```

Lancer en dev :

```bash
npm run dev
```

Build production :

```bash
npm run build
npm run build:prod
npm run preview
```

### 10) Scripts npm

- `npm run dev` : serveur Vite dev.
- `npm run build` : build TypeScript + Vite.
- `npm run build:prod` : build production + obfuscation sélective (`VITE_OBFUSCATE=0` pour désactiver).
- `npm run preview` : preview build.
- `npm run lint` : lint ESLint.
- `npm run test` : tests unitaires.
- `npm run test:watch` : tests en watch.
- `npm run test:ci` : tests + couverture.

### 11) Docker et déploiement

#### Dockerfile

- Build multi-stage :
- image Node pour compiler,
- image Nginx pour servir le `dist/`.
- Argument build : `VITE_OBFUSCATE=1` pour activer l’obfuscation sélective en prod.
- Port exposé : `3000`.

#### Docker Compose (prod)

- `transcode` :
- sert l’app (Nginx),
- labels Traefik pour HTTPS et routage.
- `gradio-proxy` :
- reverse proxy Nginx vers une instance Gradio distante.

Commande :

```bash
docker compose up --build -d
```

Option script interactif (facultatif) :

```bash
./install.sh
```

Important :

- Le lancement direct `docker compose up --build -d` reste supporté sans script.
- `install.sh` génère uniquement des overrides runtime (`docker-compose.install.override.yml`, `.env.production.local`, `docker/gradio-proxy/nginx.generated.conf`) et ne modifie pas `docker-compose.yml`.
- Valeurs par défaut du script : URL app `transcode.demeter-sante.fr`, URL Gradio `https://4e47b675ea4015a607.gradio.live`, obfuscation `1`.
- `install.sh` passe aussi `LOGIN_PASSWORDS` au build via `--env-file .env.production.local`.

#### Docker Compose (dev)

- service `transcode-dev` sur image Node,
- montage du repo et lancement `npm run dev`.

Commande :

```bash
docker compose -f docker-compose.dev.yml up -d
```

#### Script d’upload serveur

`deploy.sh` envoie les fichiers vers une machine distante via `rsync` (fallback `tar+ssh`).

Exemples :

```bash
./deploy.sh
DRY_RUN=1 ./deploy.sh
./deploy.sh user@host /chemin/remote
```

### 12) Structure du dépôt (repères)

- `src/routes/` : pages (login, local upload, cloud, llm cloud, settings, telemetry).
- `src/hooks/` : orchestration des pipelines de transcription.
- `src/lib/` : logique métier (ASR, preprocessing, chunking, cloud clients, telemetry, storage).
- `src/store/asr-store.ts` : état global et persistance.
- `public/onnx/` : assets ONNX WASM.
- `public/ffmpeg/` : assets FFmpeg WASM.
- `docker-compose*.yml`, `Dockerfile`, `docker/nginx/transcode.conf` : exécution conteneurisée et headers.

### 13) Tests et qualité

Lancer les tests :

```bash
npm run test
```

Couverture :

```bash
npm run test:ci
```

### 14) Limites connues et points d’attention

- Sécurité auth côté client uniquement (pas un remplacement d’auth serveur).
- Le multithread WASM dépend fortement de l’isolation cross-origin.
- Les modèles lourds peuvent saturer la mémoire GPU/CPU selon machine.
- La route `/mic` redirige actuellement vers `/localupload` (mode micro non exposé dans la navigation principale).

### 15) Dépannage rapide

- **Erreur “Aucun backend utilisable”** :
- vérifier `public/onnx/*`,
- vérifier headers COOP/COEP,
- vérifier console réseau.
- **Mode local très lent** :
- forcer WASM single-thread ou alléger le preset,
- réduire chunk duration / overlap,
- activer mode progressif pour gros fichiers.
- **Échec cloud Gradio** :
- vérifier URL API dans les settings cloud,
- vérifier proxy `/gradio` et `/gradio_api`.
- **Échec Whisper/Mistral** :
- vérifier tokens API et quotas,
- vérifier paramètres de chunking cloud.

### 16) LLM Cloud (Formats CRI/CRO/CRS)

- Nouvelle route : `/llmapi` (menu latéral `LLM Cloud`).
- Note : `LLM Cloud` utilise une API externe (provider distant) pour générer des comptes rendus de réunion.
- Equivalent local : utilisez `/llmlocal` pour executer le module sans API externe.
- Source au choix :
- transcription de session (`segments`),
- texte libre collé manuellement.
- Paramètres dédiés persistés en local (`llmApi*`) :
- token Hugging Face,
- `modelId`,
- `temperature`,
- `maxTokens`.
- Génération séquentielle des 3 formats :
- `CRI` (fidèle),
- `CRO` (structuré),
- `CRS` (synthèse).
- Résilience sur entrées longues :
- pipeline 2 passes (découpage + consolidation) au-delà du seuil de tokens.
- Export DOCX :
- 3 fichiers séparés (`rapport-cri-...`, `rapport-cro-...`, `rapport-crs-...`) avec mise en forme professionnelle.

---

## English

### 1) Goal

Demeter Speech is an in-browser transcription app with two execution modes:

- **Local mode**: fully browser-side ASR using `@huggingface/transformers@next` (v4 preview) + `onnxruntime-web` (WebGPU/WASM).
- **Cloud mode**: local preprocessing + remote transcription provider (Gradio, Hugging Face Whisper API, Mistral Voxtral).

The app is designed for meeting reports.

The UI also includes:

- advanced settings (model/backend/chunking/preprocessing/cloud),
- segment visualization,
- telemetry pages,
- multi-format export (`VTT`, `SRT`, `JSON`, `telemetry.json`).

### 2) Key features

- Password-gated access (bcrypt hashes injected at build time).
- Runtime backend detection (WebGPU/WASM).
- Automatic WebGPU -> WASM fallback.
- Configurable local preprocessing:
- denoise,
- high-pass / low-pass filters,
- LUFS normalization,
- limiter,
- VAD (voice activity detection),
- preprocessing auto-tuning.
- Chunking modes:
- sequential,
- overlap + dedup,
- silence-based segmentation.
- Memory modes:
- `full`,
- `progressive` (FFmpeg WASM + IndexedDB segment cache).
- Optional per-word timestamps and confidence display.
- Telemetry dashboard (timings, memory, event timeline, alerts).
- Debug tooling (log export, model compatibility test).

### 3) App flow

#### A. App startup

At startup (`src/main.tsx`):

- installs console guard + debug provider,
- runs `initializeBackendSupport()`:
- WebGPU support probe,
- ONNX WASM asset availability check under `/onnx/`,
- WASM multithread capability test,
- hydrates persisted settings from local storage,
- if no backend is available, sets an error status + toast.

#### B. Authentication

- Public route: `/login`.
- Main routes are protected (`RequireAuth` in `src/App.tsx`).
- Successful auth redirects to `/localupload`.
- Auth state is stored in `localStorage` (`demeter-authenticated`).

Important:

- This is a **client-side gate**, not hard server security.
- Password hashes are built from `LOGIN_PASSWORDS` (or `LOGIN_PASSWORD`) in `vite.config.ts`.

#### C. Local transcription (`/localupload`)

Main pipeline (`useTranscriptionController`):

1. File selection + metadata probing.
2. ASR pipeline creation (`createAsrPipeline`) from preset + backend.
3. Audio preprocessing (`quick` or `full`).
4. Chunk planning.
5. Chunk-by-chunk transcription.
6. Text normalization + overlap dedup.
7. Segment and global confidence computation.
8. Progress + telemetry updates.
9. Export.

Progressive memory mode:

- Segments media with FFmpeg WASM (`src/lib/segmenter.ts`),
- stores intermediate compressed segments in IndexedDB (`src/lib/segment-cache.ts`),
- decodes/transcribes segment by segment to reduce RAM pressure.

#### D. Cloud transcription (`/cloudupload`)

Main flow (`useCloudTranscription`):

1. Select file.
2. Local preprocessing.
3. WAV encoding.
4. Upload/submit to provider.
5. Parse provider output into normalized segments.
6. Display/export.

Available providers:

- `gradio`:
- default URL `https://transcode.demeter-sante.fr/gradio`,
- endpoint-driven Gradio flow (upload + submit + SRT/text extraction).
- `whisper`:
- requires Hugging Face token,
- uses `openai/whisper-large-v3-turbo` via HF Inference.
- `mistral`:
- requires Mistral API key,
- default API base `https://api.mistral.ai`,
- default model `voxtral-mini-latest`,
- diarization enabled by default.

Note:

- Context text is used in Gradio flows.
- In the current Whisper/Mistral implementations, context is intentionally ignored.

### 4) Persistence and storage

- `zustand`: runtime app state.
- `localStorage`:
- persisted settings (`demeter-asr-settings`),
- auth flag,
- log cache.
- `IndexedDB`:
- intermediate progressive segments,
- browser-managed model/runtime caches.
- Browser cache:
- Transformers.js model cache (`env.useBrowserCache = true`),
- static assets.

### 5) Export formats

UI export buttons provide:

- `VTT`,
- `SRT`,
- `JSON` (segments),
- `telemetry.json`.

Exports include header metadata:

- export context,
- active settings snapshot,
- runtime context (backend/model).

### 6) Security

- Active workflows: `Prod Smoke`, `CodeQL`, `Trivy`.
- Vulnerability policy: Trivy blocks the pipeline on `HIGH` and `CRITICAL`.
- Security links:
1. https://github.com/imperialsun/Demeter_CR/security
2. https://github.com/imperialsun/Demeter_CR/security/code-scanning
3. https://github.com/imperialsun/Demeter_CR/security/dependabot
4. https://github.com/imperialsun/Demeter_CR/network/dependencies
- Note: a badge may show `no status` until the workflow has run at least once.

### 7) Tech stack

- React 19, TypeScript, Vite, React Router.
- Zustand for state management.
- TailwindCSS + Radix UI components.
- Local ASR via Transformers.js + ONNX Runtime Web.
- Audio processing with Web Audio API + FFmpeg WASM.
- Vitest + Testing Library.

### 8) Requirements

- Node.js 18+ (Node 20 recommended for local dev).
- npm.
- Modern browser (Chrome/Edge recommended).
- Cross-origin isolation headers for reliable WASM multithreading:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

### 9) Local setup

```bash
npm ci
```

Create `.env`:

```bash
LOGIN_PASSWORDS=mypassword
```

Run dev server:

```bash
npm run dev
```

Build and preview:

```bash
npm run build
npm run build:prod
npm run preview
```

### 10) npm scripts

- `npm run dev`
- `npm run build`
- `npm run build:prod` (production build + selective obfuscation, disable with `VITE_OBFUSCATE=0`)
- `npm run preview`
- `npm run lint`
- `npm run test`
- `npm run test:watch`
- `npm run test:ci`

### 11) Docker and deployment

#### Dockerfile

- Multi-stage image:
- Node build stage,
- Nginx runtime stage serving static `dist`.
- Build arg: `VITE_OBFUSCATE=1` enables selective production obfuscation.
- Exposes `3000`.

#### Production compose

- `transcode`: app service with Traefik labels.
- `gradio-proxy`: Nginx reverse proxy to remote Gradio.

```bash
docker compose up --build -d
```

Optional interactive helper script:

```bash
./install.sh
```

Important:

- Direct launch with `docker compose up --build -d` remains supported without the script.
- `install.sh` only creates runtime override files (`docker-compose.install.override.yml`, `.env.production.local`, `docker/gradio-proxy/nginx.generated.conf`) and does not edit `docker-compose.yml`.
- Script defaults: app URL `transcode.demeter-sante.fr`, Gradio upstream `https://4e47b675ea4015a607.gradio.live`, obfuscation `1`.
- `install.sh` also forwards `LOGIN_PASSWORDS` to the build through `--env-file .env.production.local`.

#### Dev compose

- `transcode-dev` runs Vite in a Node container with mounted source.

```bash
docker compose -f docker-compose.dev.yml up -d
```

#### Remote upload script

`deploy.sh` uploads files via `rsync` (or `tar+ssh` fallback).

```bash
./deploy.sh
DRY_RUN=1 ./deploy.sh
./deploy.sh user@host /remote/path
```

### 12) Repository map

- `src/routes/`: pages (login/local/cloud/llm cloud/settings/telemetry).
- `src/hooks/`: orchestration logic for transcription flows.
- `src/lib/`: core business modules (ASR, preprocessing, chunking, cloud clients, telemetry, storage).
- `src/store/asr-store.ts`: global state + persistence.
- `public/onnx/`: ONNX WASM assets.
- `public/ffmpeg/`: FFmpeg WASM assets.
- Docker and proxy files at repo root.

### 13) Testing

```bash
npm run test
npm run test:ci
```

### 14) Known limitations

- Client-side auth is not equivalent to server-side access control.
- WASM multithreading depends on cross-origin isolation support.
- Large models may exceed available GPU/CPU memory.
- `/mic` currently redirects to `/localupload` (mic mode code exists but is not exposed in the main navigation).

### 15) Quick troubleshooting

- **“No usable backend found”**:
- verify `public/onnx/*`,
- verify COOP/COEP headers,
- inspect network/console errors.
- **Local mode is slow**:
- reduce model size,
- adjust chunk duration/overlap,
- use progressive mode for long files.
- **Cloud Gradio errors**:
- check configured cloud API URL,
- verify `/gradio` and `/gradio_api` proxy routing.
- **Whisper/Mistral errors**:
- verify API token/key,
- check provider quota and chunking values.

### 16) LLM Cloud (CRI/CRO/CRS Formats)

- New route: `/llmapi` (sidebar entry `LLM Cloud`).
- Note: `LLM Cloud` uses an external provider API to generate meeting reports.
- Local equivalent: use `/llmlocal` to run the module without an external API.
- Input source options:
- session transcription (`segments`),
- manually pasted free text.
- Dedicated local-persisted settings (`llmApi*`):
- Hugging Face token,
- `modelId`,
- `temperature`,
- `maxTokens`.
- Sequential generation of all three formats:
- `CRI` (high fidelity),
- `CRO` (structured concise rewrite),
- `CRS` (short synthesis).
- Long-input resilience:
- two-pass pipeline (chunk extraction + consolidation) above token threshold.
- DOCX export:
- 3 separate files (`rapport-cri-...`, `rapport-cro-...`, `rapport-crs-...`) with professional formatting.
